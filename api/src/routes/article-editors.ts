import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import {
  getArticlePermissions,
  getCollaboratorArticleIds,
  getUserRoleIds,
  getEffectiveFolderPermissions,
} from "../utils/permissions.js";

const addEditorSchema = z.object({
  userId: z.string().min(1),
});

const userSearchSchema = z.object({
  // Min length 2 — a single-char query would return a near-directory-wide
  // dropdown and invites enumeration of the user base.
  q: z.string().min(2).max(64),
  // "1" → include the caller in the results. The comment @-mention picker
  // passes it (you can @ yourself); the collaborator-add dialog omits it
  // (adding yourself as a collaborator is meaningless). Default: exclude self.
  includeSelf: z.literal("1").optional(),
});

/**
 * Routes for the per-article editor ACL — see ArticleEditor model.
 *
 * Authorization (one-sentence rule per endpoint):
 *   - LIST  editors          → caller must be article author OR admin.
 *   - ADD   editor            → same.
 *   - REMOVE editor           → same.
 *   - User search             → any authenticated user (used by the
 *                                add-editor dialog; results are limited
 *                                to id/username/displayName).
 *   - My collaborations       → returns articles where the caller
 *                                appears in ArticleEditor (NOT articles
 *                                they authored).
 *
 * Collaborators (users added via this surface) can edit the article's
 * content but cannot re-grant editors themselves — enforced by the
 * `canManageEditors` check below, which only flips true for author /
 * admin. See permissions.ts.
 */
export async function articleEditorRoutes(app: FastifyInstance): Promise<void> {
  // Resolve the article + assert the caller can manage editors. Used
  // by all three editor-CRUD endpoints, so we hoist into a helper to
  // keep the route bodies focused on their own work.
  async function loadForManage(articleId: string, user: { id: string; isAdmin: boolean }) {
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      include: { folder: true },
    });
    if (!article || article.deletedAt != null) return { kind: "not_found" as const };

    const userRoleIds = await getUserRoleIds(user.id);
    const mp = getEffectiveFolderPermissions({
      user,
      userRoleIds,
      article: { roleId: article.roleId, folder: article.folder },
    });
    const perms = getArticlePermissions({
      folderPermissions: mp,
      article: { createdById: article.createdById },
      userId: user.id, isAdmin: user.isAdmin,
      // Collaborators themselves cannot grant editors; we don't
      // need to load isCollaborator here — `canManageEditors` is
      // hardcoded to isAdmin || isAuthor.
    });
    if (!perms.canManageEditors) return { kind: "forbidden" as const };
    return { kind: "ok" as const, article };
  }

  // GET /api/articles/:id/editors — list grant rows.
  app.get<{ Params: { id: string } }>("/api/articles/:id/editors", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const res = await loadForManage(req.params.id, user);
    if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
    if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权管理协作者" });

    const rows = await prisma.articleEditor.findMany({
      where: { articleId: req.params.id },
      orderBy: { grantedAt: "asc" },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    return {
      editors: rows.map((r) => ({
        userId: r.userId,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
        grantedAt: r.grantedAt.toISOString(),
        grantedBy: r.grantedBy,
      })),
    };
  });

  // POST /api/articles/:id/editors body { userId } — add an editor.
  app.post<{ Params: { id: string } }>("/api/articles/:id/editors", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = addEditorSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const { userId } = parsed.data;

    const res = await loadForManage(req.params.id, user);
    if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
    if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权管理协作者" });

    // Self-grants are a no-op — the author is already implicitly an
    // editor. Surface as 400 so the UI can tell the user instead of
    // silently appearing to succeed but not creating a row.
    if (userId === res.article.createdById) {
      return reply.code(400).send({ error: "invalid_input", message: "作者本身无需添加为协作者" });
    }
    // Target must exist + be active. Reject early so we don't accept a
    // grant against a deleted / disabled account.
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, avatarUrl: true, isActive: true },
    });
    if (!target || !target.isActive) {
      return reply.code(404).send({ error: "not_found", message: "用户不存在或已停用" });
    }

    try {
      await prisma.articleEditor.create({
        data: { articleId: req.params.id, userId, grantedBy: user.id },
      });
    } catch (e) {
      // Idempotent: already a collaborator → return 200 instead of 409
      // so the UI doesn't need to special-case "already added". The
      // row's grantedAt / grantedBy reflect the FIRST grant.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    }
    reply.code(201);
    return {
      editor: {
        userId: target.id,
        displayName: target.displayName,
        avatarUrl: target.avatarUrl,
      },
    };
  });

  // DELETE /api/articles/:id/editors/:userId — revoke editor access.
  app.delete<{ Params: { id: string; userId: string } }>("/api/articles/:id/editors/:userId", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const res = await loadForManage(req.params.id, user);
    if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
    if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权管理协作者" });

    await prisma.articleEditor.deleteMany({
      where: { articleId: req.params.id, userId: req.params.userId },
    });
    return reply.code(204).send();
  });

  // GET /api/users/search?q= — used by the editor-add dialog. Only
  // returns active users; never admin flags / role info / email. Matches
  // on displayName via substring (case-insensitive on SQLite's default
  // collation, which is what we run on). Capped at 20 — the dialog renders
  // a dropdown, not a paginated list.
  //
  // Email is NEITHER matched NOR returned: returning it for any
  // substring match to any authenticated user is a PII / email-directory
  // enumeration leak. The dialog identifies people by displayName + avatar.
  app.get("/api/users/search", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = userSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: "搜索关键词必须 2–64 字符" });
    }
    const q = parsed.data.q;
    const includeSelf = parsed.data.includeSelf === "1";
    const matches = await prisma.user.findMany({
      where: {
        isActive: true,
        // Exclude self by default (collaborator dialog); the @-mention picker
        // opts in via includeSelf so typing your own name returns a result.
        ...(includeSelf ? {} : { NOT: { id: user.id } }),
        displayName: { contains: q },
      },
      take: 20,
      orderBy: [{ displayName: "asc" }],
      select: { id: true, displayName: true, avatarUrl: true },
    });
    return { users: matches };
  });

  // GET /api/me/collaborations — articles where I appear in
  // ArticleEditor. NOT articles I authored (those live under the
  // existing "我的文章" tab). Filters out articles I can no longer
  // see in case my folder access was revoked — a stale ArticleEditor
  // row should not leak title / author info on its own.
  app.get("/api/me/collaborations", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rows = await prisma.articleEditor.findMany({
      // Skip grants whose article is now in the recycle bin.
      where: { userId: user.id, article: { deletedAt: null } },
      orderBy: { grantedAt: "desc" },
      include: {
        article: {
          select: {
            id: true,
            title: true,
            folderId: true,
            roleId: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
            folder: { select: { id: true, name: true, roleId: true, visibility: true } },
            role: { select: { id: true, name: true, color: true } },
            createdBy: { select: { id: true, displayName: true } },
          },
        },
      },
    });

    const userRoleIds = await getUserRoleIds(user.id);
    const articleIds = rows.map((r) => r.article.id);
    const collabSet = await getCollaboratorArticleIds(user.id, articleIds);

    const visible = rows
      .map((r) => {
        const a = r.article;
        const mp = getEffectiveFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          article: { roleId: a.roleId, folder: a.folder },
        });
        const perms = getArticlePermissions({
          folderPermissions: mp,
          article: { createdById: a.createdById },
          userId: user.id, isAdmin: user.isAdmin,
          isCollaborator: collabSet.has(a.id),
        });
        return { row: r, perms };
      })
      .filter(({ perms }) => perms.canView);

    return {
      collaborations: visible.map(({ row: r, perms }) => {
        const a = r.article;
        return {
          grantedAt: r.grantedAt.toISOString(),
          article: {
            id: a.id,
            title: a.title,
            folderId: a.folderId,
            folderName: a.folder?.name ?? null,
            roleId: a.roleId,
            roleName: a.role.name,
            roleColor: a.role.color,
            createdById: a.createdById,
            createdBy: a.createdBy,
            createdAt: a.createdAt.toISOString(),
            updatedAt: a.updatedAt.toISOString(),
            permissions: perms,
          },
        };
      }),
    };
  });
}
