import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { RecycleBinItem, RecycleBinListResponse } from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { markRoleSkillStale } from "../services/role-skill/stale.js";
import { purgeMeeting } from "./meeting.js";

// Per-user, private recycle bin for soft-deleted Articles, Folders, and
// MeetingSessions. Every mutating action requires the row's
// deletedById === caller OR caller.isAdmin (403 otherwise; 404 when the
// row is missing OR not currently in the bin). Listing is strictly
// personal — even admins only see their OWN binned items here.
//
// Folder/child grouping relies on a SHARED deletedAt instant: when a
// folder is binned (routes/folders.ts) its live child articles are
// stamped with the SAME Date, so we can match "the docs that went down
// with this folder" by exact deletedAt equality.
export async function recycleBinRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/recycle-bin — the caller's own binned items, newest first.
  app.get("/api/recycle-bin", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const me = user.id;

    const [meetings, folders, articles] = await Promise.all([
      prisma.meetingSession.findMany({
        where: { deletedById: me, deletedAt: { not: null } },
        select: { id: true, title: true, deletedAt: true },
      }),
      prisma.folder.findMany({
        where: { deletedById: me, deletedAt: { not: null } },
        select: {
          id: true, name: true, roleId: true, parentId: true, deletedAt: true,
          role: { select: { name: true } },
        },
      }),
      prisma.article.findMany({
        where: { deletedById: me, deletedAt: { not: null } },
        select: {
          id: true, title: true, roleId: true, folderId: true, deletedAt: true,
          role: { select: { name: true } },
          folder: { select: { name: true, deletedAt: true, parentId: true } },
        },
      }),
    ]);

    // Map each binned folder id → its deletedAt (ms). Powers both subtree-root
    // detection and the docCount roll-up below.
    const binnedAt = new Map<string, number>();
    for (const f of folders) if (f.deletedAt) binnedAt.set(f.id, f.deletedAt.getTime());

    // A binned folder is a SUBTREE ROOT unless it was co-deleted with its
    // parent (same deletedAt). Subfolders that went down WITH their parent are
    // represented by the parent's entry, not listed individually.
    const isRoot = (f: typeof folders[number]) => {
      if (f.parentId == null) return true;
      const pAt = binnedAt.get(f.parentId);
      return !(pAt != null && f.deletedAt != null && pAt === f.deletedAt.getTime());
    };

    // Per-root count of subtree docs binned with it (same deletedAt). A doc in
    // a co-deleted subfolder rolls UP to that subfolder's parent (the root), so
    // the root entry reports the whole subtree's doc count.
    const folderDocCounts = new Map<string, number>();
    for (const a of articles) {
      if (!a.folderId || !a.folder?.deletedAt || !a.deletedAt) continue;
      if (a.folder.deletedAt.getTime() !== a.deletedAt.getTime()) continue; // not part of a folder cascade
      let rootId = a.folderId;
      if (a.folder.parentId) {
        const pAt = binnedAt.get(a.folder.parentId);
        if (pAt != null && pAt === a.deletedAt.getTime()) rootId = a.folder.parentId;
      }
      folderDocCounts.set(rootId, (folderDocCounts.get(rootId) ?? 0) + 1);
    }

    const items: RecycleBinItem[] = [
      ...meetings.map((m): RecycleBinItem => ({
        type: "meeting",
        id: m.id,
        title: m.title,
        deletedAt: m.deletedAt!.toISOString(),
      })),
      // Only subtree ROOTS are listed; co-deleted subfolders are folded into
      // their root's entry (and counted in its docCount).
      ...folders.filter(isRoot).map((f): RecycleBinItem => ({
        type: "folder",
        id: f.id,
        name: f.name,
        roleId: f.roleId,
        roleName: f.role.name,
        docCount: folderDocCounts.get(f.id) ?? 0,
        deletedAt: f.deletedAt!.toISOString(),
      })),
      // Exclude docs that were cascaded with a folder (folder soft-deleted
      // with the SAME deletedAt) — those are represented by the folder
      // entry, not individually. An article whose folder is in the bin but
      // with a DIFFERENT deletedAt (deleted separately) still shows here.
      ...articles
        .filter((a) => !(
          a.folder?.deletedAt && a.deletedAt &&
          a.folder.deletedAt.getTime() === a.deletedAt.getTime()
        ))
        .map((a): RecycleBinItem => ({
          type: "article",
          id: a.id,
          title: a.title,
          roleId: a.roleId,
          roleName: a.role.name,
          // Container label. Only show a folder name when that folder is
          // itself LIVE. If the parent folder is gone (folderId SetNull'd
          // on a folder purge) OR is itself in the bin under a DIFFERENT
          // deletedAt (binned separately from this doc), the doc is
          // effectively role-direct here — showing the binned/now-gone
          // folder's name would dangle a label onto a container the user
          // can't see. This matches article-restore, which detaches such a
          // doc to role-direct (folderId=null).
          folderName: a.folder && a.folder.deletedAt == null ? a.folder.name : null,
          deletedAt: a.deletedAt!.toISOString(),
        })),
    ];

    // Newest-deleted first across all three sources.
    items.sort((x, y) => y.deletedAt.localeCompare(x.deletedAt));

    return { items } satisfies RecycleBinListResponse;
  });

  // POST /api/recycle-bin/article/:id/restore
  app.post<{ Params: { id: string } }>("/api/recycle-bin/article/:id/restore", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const a = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: { folder: { select: { deletedAt: true } } },
    });
    if (!a || a.deletedAt == null) return reply.code(404).send({ error: "not_found", message: "回收项不存在" });
    if (a.deletedById !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "forbidden", message: "无权恢复该文档" });
    }

    // If the article's folder is itself still in the bin, detach the doc
    // (folderId=null → role-direct) so it isn't restored under a deleted
    // folder. The doc keeps its roleId, so it resurfaces as a role-direct
    // leaf in the tree.
    const orphaned = a.folderId != null && a.folder?.deletedAt != null;
    await prisma.article.update({
      where: { id: a.id },
      data: {
        deletedAt: null,
        deletedById: null,
        ...(orphaned ? { folderId: null } : {}),
      },
    });
    // Restoring a published doc puts it back in the role's published set.
    markRoleSkillStale(a.roleId);
    return reply.code(204).send();
  });

  // POST /api/recycle-bin/folder/:id/restore — restores the folder AND the
  // subtree that went down with it (matched by the folder's old deletedAt).
  // SIMPLIFIED RESTORE: every restored folder is FLATTENED to top-level
  // (parentId=null) — we don't rebuild the parent/child hierarchy. Docs keep
  // their folderId (their folder is restored alongside, now top-level), so no
  // doc is orphaned. Docs deleted individually (different deletedAt) stay binned.
  app.post<{ Params: { id: string } }>("/api/recycle-bin/folder/:id/restore", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const f = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!f || f.deletedAt == null) return reply.code(404).send({ error: "not_found", message: "回收项不存在" });
    if (f.deletedById !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "forbidden", message: "无权恢复该目录" });
    }

    const folderDeletedAt = f.deletedAt;
    const roleId = f.roleId;

    // Restored folders all land at top-level. SQLite does NOT enforce the
    // (roleId, parentId, name) unique index for NULL parentId, so P2002 won't
    // fire for a top-level name clash — we pick a free name in app code instead,
    // among the role's LIVE top-level folders. Sequential restore means a
    // just-restored sibling is already live + counted on the next call, so
    // names don't collide within the batch either.
    async function freeTopLevelName(tx: Prisma.TransactionClient, base: string, selfId: string): Promise<string> {
      const taken = new Set(
        (await tx.folder.findMany({
          where: { roleId, parentId: null, deletedAt: null, id: { not: selfId } },
          select: { name: true },
        })).map((r) => r.name),
      );
      if (!taken.has(base)) return base;
      const candidates = [
        `${base}（恢复 ${selfId.slice(0, 6)}）`,
        ...Array.from({ length: 20 }, (_, i) => `${base}（恢复 ${selfId.slice(0, 6)}-${i + 1}）`),
        `${base}（恢复 ${selfId}）`,
      ];
      for (const c of candidates) if (!taken.has(c)) return c;
      return `${base}（恢复 ${selfId}）`;
    }

    await prisma.$transaction(async (tx) => {
      // Subfolders that went down WITH this folder (shared deletedAt).
      const subs = await tx.folder.findMany({
        where: { parentId: f.id, deletedAt: folderDeletedAt },
        select: { id: true, name: true },
      });
      const subIds = subs.map((s) => s.id);

      // Co-deleted docs across the subtree come back in place (folderId kept;
      // their folder is restored to top-level below).
      await tx.article.updateMany({
        where: { folderId: { in: [f.id, ...subIds] }, deletedAt: folderDeletedAt },
        data: { deletedAt: null, deletedById: null },
      });

      // Restore every folder to top-level (parentId=null), each with a name
      // free among LIVE top-level siblings. Sequential so a restored sibling
      // is visible to the next freeTopLevelName lookup (avoids intra-batch dups).
      // ROOT FIRST: when the deleted folder and one of its subfolders share a
      // name, the root (the thing the user deleted) keeps its clean name and the
      // colliding subfolder takes the「（恢复 …）」suffix — the intuitive outcome.
      const toRestore = [{ id: f.id, name: f.name }, ...subs];
      for (const fr of toRestore) {
        const name = await freeTopLevelName(tx, fr.name, fr.id);
        await tx.folder.update({
          where: { id: fr.id },
          data: { deletedAt: null, deletedById: null, parentId: null, name },
        });
      }
    });
    // Folder restore may bring published docs back; refresh the role's skill
    // (the no-op guard skips regeneration when nothing published actually changed).
    markRoleSkillStale(roleId);
    return reply.code(204).send();
  });

  // POST /api/recycle-bin/meeting/:id/restore
  app.post<{ Params: { id: string } }>("/api/recycle-bin/meeting/:id/restore", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const m = await prisma.meetingSession.findUnique({ where: { id: req.params.id } });
    if (!m || m.deletedAt == null) return reply.code(404).send({ error: "not_found", message: "回收项不存在" });
    if (m.deletedById !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "forbidden", message: "无权恢复该会议" });
    }

    await prisma.meetingSession.update({
      where: { id: m.id },
      data: { deletedAt: null, deletedById: null },
    });
    return reply.code(204).send();
  });

  // DELETE /api/recycle-bin/article/:id — permanent hard delete. FK
  // cascades drop versions / references / bookmarks / likes / comments.
  app.delete<{ Params: { id: string } }>("/api/recycle-bin/article/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const a = await prisma.article.findUnique({ where: { id: req.params.id } });
    if (!a || a.deletedAt == null) return reply.code(404).send({ error: "not_found", message: "回收项不存在" });
    if (a.deletedById !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "forbidden", message: "无权删除该文档" });
    }

    await prisma.article.delete({ where: { id: a.id } });
    return reply.code(204).send();
  });

  // DELETE /api/recycle-bin/folder/:id — permanent. Hard-delete the
  // co-deleted child articles (matched by the folder's deletedAt) then
  // the folder row itself.
  app.delete<{ Params: { id: string } }>("/api/recycle-bin/folder/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const f = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!f || f.deletedAt == null) return reply.code(404).send({ error: "not_found", message: "回收项不存在" });
    if (f.deletedById !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "forbidden", message: "无权删除该目录" });
    }

    const folderDeletedAt = f.deletedAt;
    // Subfolders that went down WITH this folder (shared deletedAt) are part of
    // its cascade and get hard-deleted along with it.
    const coSubIds = (
      await prisma.folder.findMany({ where: { parentId: f.id, deletedAt: folderDeletedAt }, select: { id: true } })
    ).map((s) => s.id);
    const subtreeIds = [f.id, ...coSubIds];
    await prisma.$transaction([
      // Hard-delete the docs that went down WITH the folder (shared deletedAt),
      // across the whole co-deleted subtree (this folder + its subfolders).
      prisma.article.deleteMany({ where: { folderId: { in: subtreeIds }, deletedAt: folderDeletedAt } }),
      // Docs binned INDIVIDUALLY earlier (a DIFFERENT deletedAt) anywhere in the
      // subtree are NOT part of this cascade — detach them to role-direct so
      // they survive as restorable bin items (mirrors article-restore's detach).
      prisma.article.updateMany({
        where: { folderId: { in: subtreeIds }, deletedAt: { not: folderDeletedAt } },
        data: { folderId: null },
      }),
      // Subfolders binned SEPARATELY (parentId=this, but a DIFFERENT deletedAt)
      // are NOT part of this cascade — promote them to top-level so they survive
      // as restorable bin items rather than vanishing with the purged parent.
      prisma.folder.updateMany({
        where: { parentId: f.id, deletedAt: { not: folderDeletedAt } },
        data: { parentId: null },
      }),
      // Hard-delete the co-deleted subfolders, then the folder itself.
      prisma.folder.deleteMany({ where: { id: { in: coSubIds } } }),
      prisma.folder.delete({ where: { id: f.id } }),
    ]);
    return reply.code(204).send();
  });

  // DELETE /api/recycle-bin — 一键清空:永久删除调用者自己回收站里的
  // 全部内容(文档/目录/会议)。语义与单项永久删除对齐:
  //   - 只动 deletedById === 我 的回收项(目录软删时整棵子树连同文档都
  //     stamped 同一 deletedById,所以「我删的」自洽覆盖整个级联);
  //   - 别人删的文档/子目录若挂在我要硬删的目录下 → 摘到角色直挂/提升
  //     顶层,保住他们的回收项(镜像单目录 purge 的 detach 规则);
  //   - 会议逐个走 purgeMeeting(要 unlink 音频文件,无法批量 SQL)。
  app.delete("/api/recycle-bin", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const me = user.id;

    const meetings = await prisma.meetingSession.findMany({
      where: { deletedById: me, deletedAt: { not: null } },
    });
    // 逐个 best-effort:一场会议的音频 unlink 失败不拦下后面的;返回真实
    // 成功数(unlink 不可回滚,本段天然非事务)。
    let purgedMeetings = 0;
    for (const m of meetings) {
      try {
        await purgeMeeting(m);
        purgedMeetings++;
      } catch (err) {
        req.log.warn({ err, meetingId: m.id }, "recycle-bin clear: purge meeting failed");
      }
    }

    const myFolderIds = (
      await prisma.folder.findMany({
        where: { deletedById: me, deletedAt: { not: null } },
        select: { id: true },
      })
    ).map((f) => f.id);

    const { articles, folders } = await prisma.$transaction(async (tx) => {
      // 我删的文档(含随目录级联进回收站的)全部硬删;FK 级联清掉
      // versions/references/bookmarks/likes/comments。
      const articles = await tx.article.deleteMany({
        where: { deletedById: me, deletedAt: { not: null } },
      });
      let folders = { count: 0 };
      if (myFolderIds.length > 0) {
        // 仍挂在这些目录下、且在回收站里的文档(只剩「别人删的」,我删的
        // 上一步已硬删)→ 摘到角色直挂,保住他们的回收项。live 文档不在
        // 此显式处理 —— 目录行删除时 FK onDelete: SetNull 会兜底摘挂,
        // 行为一致;加 deletedAt 过滤只为语义清晰,不动无关行。
        await tx.article.updateMany({
          where: { folderId: { in: myFolderIds }, deletedAt: { not: null } },
          data: { folderId: null },
        });
        // 同理:别人单独删进回收站的子目录提升为顶层,保住其回收项。
        await tx.folder.updateMany({
          where: { parentId: { in: myFolderIds }, id: { notIn: myFolderIds } },
          data: { parentId: null },
        });
        folders = await tx.folder.deleteMany({ where: { id: { in: myFolderIds } } });
      }
      return { articles: articles.count, folders: folders.count };
    });

    return { purged: { articles, folders, meetings: purgedMeetings } };
  });

  // DELETE /api/recycle-bin/meeting/:id — permanent. Reuses the shared
  // purgeMeeting helper (unlink .wav/.mp3 files + delete row + FK
  // cascade of transcripts/comments).
  app.delete<{ Params: { id: string } }>("/api/recycle-bin/meeting/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const m = await prisma.meetingSession.findUnique({ where: { id: req.params.id } });
    if (!m || m.deletedAt == null) return reply.code(404).send({ error: "not_found", message: "回收项不存在" });
    if (m.deletedById !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "forbidden", message: "无权删除该会议" });
    }

    await purgeMeeting(m);
    return reply.code(204).send();
  });
}
