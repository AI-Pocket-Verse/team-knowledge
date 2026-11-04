import { L } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import {
  getFolderPermissions, asFolderVisibility,
  getUserRoleIds, getArticlePermissions, getCollaboratorArticleIds,
  getRoleDirectPermissions,
} from "../utils/permissions.js";

function toRole(r: { id: string; name: string; description: string | null; color: string | null; createdAt: Date }) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    createdAt: r.createdAt.toISOString(),
  };
}

function toFolderRow(m: {
  id: string;
  name: string;
  description: string | null;
  roleId: string;
  parentId: string | null;
  visibility: string;
  templateType: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    roleId: m.roleId,
    parentId: m.parentId,
    visibility: asFolderVisibility(m.visibility),
    templateType: m.templateType,
    createdById: m.createdById,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspace/roles", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userRoleIds = await getUserRoleIds(user.id);

    const [allRoles, pins] = await Promise.all([
      prisma.role.findMany({
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { folders: { where: { deletedAt: null } } } } },
      }),
      // 本用户的个人置顶(每人各自);带 pinnedAt 供「最近置顶在最上」排序。
      prisma.userRolePin.findMany({ where: { userId: user.id }, select: { roleId: true, pinnedAt: true } }),
    ]);
    const pinnedAtByRole = new Map(pins.map((p) => [p.roleId, p.pinnedAt.getTime()]));

    // Show ALL roles in the sidebar — the role list is a browseable catalog.
    // Folders no longer have a public/private flag: every folder is visible to
    // everyone, so `folderCount` is simply the role's folder count for all
    // users. "owned" (member/admin) vs "readonly" only controls edit rights.
    type Visible = ReturnType<typeof toRole> & { ownership: "owned" | "readonly"; folderCount: number; pinned: boolean };
    const owned: Visible[] = [];
    const others: Visible[] = [];

    for (const r of allRoles) {
      const isOwner = user.isAdmin || userRoleIds.has(r.id);
      const v: Visible = { ...toRole(r), ownership: isOwner ? "owned" : "readonly", folderCount: r._count.folders, pinned: pinnedAtByRole.has(r.id) };
      (isOwner ? owned : others).push(v);
    }

    // 排序:个人置顶的角色浮到【最顶】,组内按【最近置顶在最上】(pinnedAt 倒序);
    // 未置顶的保留 owned-first + createdAt 相对序。
    const ordered = [...owned, ...others];
    const pinned = ordered.filter((r) => r.pinned).sort((a, b) => (pinnedAtByRole.get(b.id) ?? 0) - (pinnedAtByRole.get(a.id) ?? 0));
    return { roles: [...pinned, ...ordered.filter((r) => !r.pinned)] };
  });

  // 文档边栏角色的【个人置顶】开关(每人各自;任意可浏览角色皆可)。pinned=true 置顶、false 取消。
  app.patch<{ Params: { roleId: string }; Body: { pinned?: boolean } }>("/api/workspace/roles/:roleId/pin", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (typeof req.body?.pinned !== "boolean") return reply.code(400).send({ error: "pinned must be a boolean" });
    // 校验角色存在(避免置顶已删角色触发 FK 错)。角色是全员可浏览目录 → 不做归属校验。
    const role = await prisma.role.findUnique({ where: { id: req.params.roleId }, select: { id: true } });
    if (!role) return reply.code(404).send({ error: "role not found" });
    if (req.body.pinned) {
      await prisma.userRolePin.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        create: { userId: user.id, roleId: role.id },
        update: { pinnedAt: new Date() }, // 再次置顶 → 刷新时间戳,移到最上
      });
    } else {
      await prisma.userRolePin.deleteMany({ where: { userId: user.id, roleId: role.id } });
    }
    return { ok: true };
  });

  app.get<{ Params: { roleId: string } }>("/api/workspace/roles/:roleId/folders", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const role = await prisma.role.findUnique({ where: { id: req.params.roleId } });
    if (!role) return reply.code(404).send({ error: "not_found", message: L(req, "角色不存在", "Role not found") });

    const userRoleIds = await getUserRoleIds(user.id);

    const folders = await prisma.folder.findMany({
      where: { roleId: role.id, deletedAt: null },
      // Drag-reorder sortOrder first; createdAt as the tiebreaker so
      // a fresh role with everything at sortOrder=0 still has a
      // deterministic visible order.
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    const visible = folders
      .map((m) => ({
        m,
        perms: getFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          folder: { roleId: m.roleId, visibility: asFolderVisibility(m.visibility) },
        }),
      }))
      .filter(({ perms }) => perms.canView);

    // Previously this returned 403 when an outsider hit a role with
    // no public folders. Now that the sidebar lists every role for
    // browsing, the outsider clicking through gets an empty list +
    // a friendly empty-state in the UI instead of an error toast.
    return {
      folders: visible.map(({ m, perms }) => ({
        ...toFolderRow(m),
        permissions: perms,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/workspace/folders/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const m = await prisma.folder.findUnique({
      where: { id: req.params.id },
      include: {
        role: true,
        createdBy: { select: { id: true, displayName: true } },
      },
    });
    if (!m || m.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "目录不存在", "Folder not found") });

    const userRoleIds = await getUserRoleIds(user.id);
    const permissions = getFolderPermissions({
      user: { id: user.id, isAdmin: user.isAdmin },
      userRoleIds,
      folder: { roleId: m.roleId, visibility: asFolderVisibility(m.visibility) },
    });

    if (!permissions.canView) {
      return reply.code(403).send({ error: "forbidden", message: L(req, "无权访问该目录", "No permission to access this folder") });
    }

    return {
      folder: {
        ...toFolderRow(m),
        permissions,
        role: toRole(m.role),
        createdBy: m.createdBy,
      },
    };
  });

  // GET /api/workspace/roles/:roleId/tree — sidebar's data source.
  // Returns the role's tree: folders (with their docs inside) +
  // role-direct docs (no folder wrap). Permission-filtered: a
  // viewer only sees folders/docs they can read.
  //
  // Response shape:
  //   {
  //     folders: [{ ...folder, articles: [{ slim article }] }],
  //     directArticles: [{ slim article }]
  //   }
  // Slim article = id/title/status/sortOrder/permissions — enough
  // for the sidebar row, no body content.
  app.get<{ Params: { roleId: string } }>("/api/workspace/roles/:roleId/tree", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const role = await prisma.role.findUnique({ where: { id: req.params.roleId } });
    if (!role) return reply.code(404).send({ error: "not_found", message: L(req, "角色不存在", "Role not found") });

    const userRoleIds = await getUserRoleIds(user.id);

    // Load all folders + all articles under this role in two queries,
    // then group in code. Cheaper than one query per folder.
    const [folders, articles] = await Promise.all([
      prisma.folder.findMany({
        where: { roleId: role.id, deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      prisma.article.findMany({
        where: { roleId: role.id, deletedAt: null },
        // Deterministic, stable sibling order shared with the folder feed
        // (me.ts) + folders/:id/articles so the sidebar and the folder page
        // never disagree. createdAt+id never change, so editing a doc can't
        // reshuffle same-sortOrder siblings (updatedAt desc used to).
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          folderId: true,
          roleId: true,
          sortOrder: true,
          createdById: true,
          updatedAt: true,
          reviewStatus: true,
          createdBy: { select: { id: true, displayName: true } },
        },
      }),
    ]);

    // Per-article collaborator flags loaded in one round-trip so
    // sidebar permission computation doesn't fan out to N queries.
    const collabIds = await getCollaboratorArticleIds(user.id, articles.map((a) => a.id));

    // Build a folder-id → FolderPermissions map for folder-scoped
    // article visibility checks below.
    const folderPermsById = new Map<string, ReturnType<typeof getFolderPermissions>>();
    const visibleFolders = folders.filter((m) => {
      const perms = getFolderPermissions({
        user: { id: user.id, isAdmin: user.isAdmin },
        userRoleIds,
        folder: { roleId: m.roleId, visibility: asFolderVisibility(m.visibility) },
      });
      folderPermsById.set(m.id, perms);
      return perms.canView;
    });

    // Direct-article permissions use role-direct rules (no folder
    // visibility to consult).
    const directMp = getRoleDirectPermissions({
      user: { id: user.id, isAdmin: user.isAdmin },
      userRoleIds,
      roleId: role.id,
    });

    function slimArticle(a: typeof articles[number], mp: ReturnType<typeof getFolderPermissions>) {
      const perms = getArticlePermissions({
        folderPermissions: mp,
        article: { createdById: a.createdById },
        userId: user!.id,
        isAdmin: user!.isAdmin,
        isCollaborator: collabIds.has(a.id),
      });
      return {
        id: a.id,
        title: a.title,
        folderId: a.folderId,
        roleId: a.roleId,
        sortOrder: a.sortOrder,
        createdById: a.createdById,
        createdBy: a.createdBy,
        updatedAt: a.updatedAt.toISOString(),
        permissions: perms,
        reviewStatus: a.reviewStatus,
      };
    }

    // Folder children — group by folderId, then filter by canView.
    const articlesByFolder = new Map<string, typeof articles>();
    const directArticles: typeof articles = [];
    for (const a of articles) {
      if (a.folderId === null) {
        directArticles.push(a);
        continue;
      }
      const bucket = articlesByFolder.get(a.folderId) ?? [];
      bucket.push(a);
      articlesByFolder.set(a.folderId, bucket);
    }

    // Named recursive type — an explicit annotation is required because
    // buildFolderRow references its own return type (children), which TS
    // can't infer implicitly (TS7023).
    type TreeFolderRow = ReturnType<typeof toFolderRow> & {
      permissions: ReturnType<typeof getFolderPermissions>;
      articles: ReturnType<typeof slimArticle>[];
      children: TreeFolderRow[];
    };

    // Assemble one folder into a FolderRow (with its own direct docs).
    // `children` defaults empty; only top-level folders get it populated below.
    function buildFolderRow(
      m: typeof visibleFolders[number],
      mp: ReturnType<typeof getFolderPermissions>,
    ): TreeFolderRow {
      const kids = articlesByFolder.get(m.id) ?? [];
      const visibleKids = kids.map((a) => slimArticle(a, mp)).filter((s) => s.permissions.canView);
      return {
        ...toFolderRow(m),
        permissions: mp,
        articles: visibleKids,
        children: [] as TreeFolderRow[],
      };
    }

    // Group visible folders by parentId: top-level folders + subfolders per parent.
    const topLevel: typeof visibleFolders = [];
    const subByParent = new Map<string, typeof visibleFolders>();
    for (const m of visibleFolders) {
      if (m.parentId == null) {
        topLevel.push(m);
      } else {
        const bucket = subByParent.get(m.parentId) ?? [];
        bucket.push(m);
        subByParent.set(m.parentId, bucket);
      }
    }

    const topLevelIds = new Set(topLevel.map((m) => m.id));
    // Defensive: a subfolder whose parent isn't a visible top-level folder of
    // this role (data drift — e.g. a cross-role move, a partial hard-delete, a
    // stale parentId) would otherwise be silently dropped from the tree. Surface
    // those orphans as top-level rows so no folder/doc ever disappears.
    const orphanSubs: typeof visibleFolders = [];
    for (const [pid, subs] of subByParent) {
      if (!topLevelIds.has(pid)) orphanSubs.push(...subs);
    }

    return {
      folders: [
        ...topLevel.map((m) => {
          const row = buildFolderRow(m, folderPermsById.get(m.id)!);
          row.children = (subByParent.get(m.id) ?? []).map((c) =>
            buildFolderRow(c, folderPermsById.get(c.id)!),
          );
          return row;
        }),
        ...orphanSubs.map((m) => buildFolderRow(m, folderPermsById.get(m.id)!)),
      ],
      directArticles: directArticles
        .map((a) => slimArticle(a, directMp))
        .filter((s) => s.permissions.canView),
    };
  });
}
