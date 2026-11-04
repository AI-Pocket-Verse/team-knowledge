import { L, appLang } from "../utils/lang.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { ASSISTANT_NAME } from "../utils/assistant.js";
import { openPageKeys } from "../services/admin-visibility/index.js";
import { startOfBeijingDayMinus } from "../utils/day.js";
import { pageActivity } from "../services/activity.js";
import {
  getArticlePermissions,
  getUserRoleIds,
  getCollaboratorArticleIds,
  getEffectiveFolderPermissions,
} from "../utils/permissions.js";

// Compact shape used by the personal-page tab lists. Drops
// contentMarkdown + preview + image so the rows ship lean — the
// profile tabs don't need a preview snippet or thumbnail.
function toFeedRow(a: {
  id: string;
  title: string;
  folderId: string | null;
  roleId: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Folder is optional now — role-direct docs have folderId=null and
  // folder=null. The role record is the source of truth for the row's
  // role color/name display.
  folder: { roleId: string; visibility: string; name: string } | null;
  role: { name: string; color: string | null };
  // Author info surfaced in feed rows. Null when hard-deleted.
  createdBy: { id: string; displayName: string } | null;
  reviewStatus?: string;
}, viewer: { id: string; isAdmin: boolean }, userRoleIds: Set<string>, collabIds: Set<string>) {
  const mp = getEffectiveFolderPermissions({
    user: viewer,
    userRoleIds,
    article: { roleId: a.roleId, folder: a.folder },
  });
  const perms = getArticlePermissions({
    folderPermissions: mp,
    article: { createdById: a.createdById },
    userId: viewer.id, isAdmin: viewer.isAdmin,
    isCollaborator: collabIds.has(a.id),
  });
  return {
    id: a.id,
    title: a.title,
    folderId: a.folderId,
    folderName: a.folder?.name ?? null,
    roleId: a.roleId,
    roleName: a.role.name,
    roleColor: a.role.color,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    createdBy: a.createdBy,
    permissions: perms,
    reviewStatus: a.reviewStatus,
  };
}

// Self-service profile edit. Identity fields (displayName, avatar, email/
// mobile) come from the platform SSO (Feishu): set at JIT-provision time and
// shown read-only — NOT user-editable here. isAdmin / isActive are admin-only.
// The only self-editable field is the free-text chat preference.
const makeProfilePatchSchema = (req: FastifyRequest) => z.object({
  // Free-text chat preference fed into every chat turn's system prompt.
  // 200-char cap keeps the prompt from being hijacked by a runaway preference
  // string; empty string clears it (stored as null in DB).
  chatPreference: z.string().trim().max(200, L(req, "聊天偏好最长 200 字", "Chat preference can be at most 200 characters")).nullable().optional(),
});

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/me/admin-access — 当前用户能否进入管理后台 + 哪些页面已对所有成员放开。
  // 驱动头像菜单「管理后台」显隐 / 侧栏过滤 / 路由守卫。只暴露布尔/页面 key,不含页面数据。
  app.get("/api/me/admin-access", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { isAdmin: user.isAdmin, openPages: await openPageKeys() };
  });

  app.get("/api/me", async (req, reply) => {
    // No SSO identity on the request → not logged in. Return the same
    // `{ user: null }` shape the client's auth bootstrap expects rather
    // than a 401 (that would force the SSO redirect on every cold load).
    if (!req.user) return { user: null, assistantName: ASSISTANT_NAME, appLanguage: appLang() };
    // Authenticated: JIT-provision (race-safe) and return the local user.
    // requireUser sends its own 403 if the local row is inactive; in that
    // case it already replied, so we bail out and let that response stand.
    const user = await requireUser(req, reply);
    if (!user) return reply;
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin,
        isActive: user.isActive,
        chatPreference: user.chatPreference,
        createdAt: user.createdAt.toISOString(),
      },
      // 助手显示名由服务端配置（ASSISTANT_NAME），web 不硬编码。
      assistantName: ASSISTANT_NAME,
      appLanguage: appLang(),
    };
  });

  app.patch("/api/me/profile", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = makeProfilePatchSchema(req).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    // Reject a no-op patch so the client doesn't accidentally bump updatedAt.
    if (parsed.data.chatPreference === undefined) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "无可更新字段", "No fields to update") });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        // Normalize "" to null so the DB column stays clean and the chat
        // route's null-guard treats "cleared" as "no preference".
        chatPreference: parsed.data.chatPreference && parsed.data.chatPreference.length > 0 ? parsed.data.chatPreference : null,
      },
    });
    return {
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        avatarUrl: updated.avatarUrl,
        isAdmin: updated.isAdmin,
        isActive: updated.isActive,
        chatPreference: updated.chatPreference,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  });

  // GET /api/me/activity?page=1&days=30 — the caller's OWN recent dynamics,
  // paginated 10/page. Same aggregation the admin dashboard uses for a user,
  // but self-scoped (any logged-in user, no admin needed). Powers the 动态 tab.
  app.get<{ Querystring: { page?: string; days?: string } }>("/api/me/activity", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const pageRaw = Number(req.query.page);
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) ? Math.min(60, Math.max(1, Math.trunc(daysRaw))) : 30;
    const windowStart = startOfBeijingDayMinus(new Date(), days - 1);
    return pageActivity({ windowStart, userId: user.id, page, pageSize: 10 });
  });

  // GET /api/me/articles — articles the caller authored. Used by the
  // 文档 tab on the profile page. Ordered newest first.
  app.get("/api/me/articles", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const userRoleIds = await getUserRoleIds(user.id);
    const rows = await prisma.article.findMany({
      where: { createdById: user.id, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, title: true, folderId: true, roleId: true, createdById: true,
        createdAt: true, updatedAt: true, reviewStatus: true,
        folder: { select: { name: true, roleId: true, visibility: true } },
        role: { select: { name: true, color: true } },
        createdBy: { select: { id: true, displayName: true } },
      },
    });
    // Author's own articles never need collab lookup (they're the author),
    // but pass the set for the shared toFeedRow signature.
    const collabIds = await getCollaboratorArticleIds(user.id, rows.map((r) => r.id));
    return { articles: rows.map((a) => toFeedRow(a, user, userRoleIds, collabIds)) };
  });

  // GET /api/me/feed?roleId=&folderId=&take= — cross-folder time-flow
  // used by the home/role/folder landing pages. Returns the same
  // FeedArticleRow shape as /api/me/articles. Role-based permission
  // filter is applied per-article via getArticlePermissions.canView.
  //
  // Filters compose: when both roleId and folderId are present, the
  // folder filter wins (folders belong to one role anyway). When
  // neither is given, every article the caller can see is returned.
  app.get<{ Querystring: { roleId?: string; folderId?: string; take?: string } }>(
    "/api/me/feed",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      // 重复的 query 参数会被解析成数组,直接进 where 会让 Prisma 抛 500。
      if ([req.query.roleId, req.query.folderId, req.query.take].some((v) => v !== undefined && typeof v !== "string")) {
        return reply.code(400).send({ error: "invalid_input", message: L(req, "查询参数不能重复", "Query parameters cannot be repeated") });
      }
      const userRoleIds = await getUserRoleIds(user.id);

      const takeRaw = Number(req.query.take ?? 100);
      const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 200) : 100;

      // Push visibility into the QUERY so `take` returns only
      // rows the caller can actually view — otherwise we'd `take` N rows,
      // 去草稿隐私后,所有未删除文档对登录用户可见(canView 恒真),无需可见性过滤。
      // Build the where-clause from optional filters. folderId filters
      // to a specific folder; if present we drop the roleId join entirely.
      // For roleId we read off Article.roleId directly (denormalized +
      // always set) so role-direct docs (folderId IS NULL) stay in the
      // feed — querying via `{ folder: { roleId } }` would JOIN through
      // Folder and silently drop every role-direct row.
      const where = req.query.folderId
        ? { folderId: req.query.folderId, deletedAt: null }
        : req.query.roleId
          ? { roleId: req.query.roleId, deletedAt: null }
          : { deletedAt: null };

      const rows = await prisma.article.findMany({
        where,
        // A FOLDER view mirrors the sidebar's manual drag-order (sortOrder) so
        // the folder page and the tree never disagree; the cross-folder / role /
        // home feed stays a recency time-flow. createdAt+id are STABLE
        // tiebreakers — updatedAt would reshuffle same-sortOrder siblings on
        // every edit. Must match workspace.ts (tree) + folders/:id/articles.
        orderBy: req.query.folderId
          ? [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }]
          : [{ updatedAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true, title: true, folderId: true, roleId: true, createdById: true,
          createdAt: true, updatedAt: true, reviewStatus: true,
          folder: { select: { name: true, roleId: true, visibility: true } },
          role: { select: { name: true, color: true } },
          createdBy: { select: { id: true, displayName: true } },
        },
      });
      // Surface articles I collaborate on in the cross-folder feed too,
      // otherwise a private-folder collab is invisible from the home page.
      const collabIds = await getCollaboratorArticleIds(user.id, rows.map((r) => r.id));
      const visible = rows
        .map((r) => toFeedRow(r, user, userRoleIds, collabIds))
        .filter((r) => r.permissions.canView);
      return { articles: visible };
    },
  );

  // GET /api/me/likes — articles the caller has liked, newest first.
  app.get("/api/me/likes", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const userRoleIds = await getUserRoleIds(user.id);
    const likes = await prisma.like.findMany({
      // Hide likes whose article is now in the recycle bin. 去草稿隐私后,其余
      // 未删除文档对登录用户都可见,无需再按 status 过滤。
      where: {
        userId: user.id,
        article: { deletedAt: null },
      },
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        article: {
          select: {
            id: true, title: true, folderId: true, roleId: true, createdById: true,
            createdAt: true, updatedAt: true, reviewStatus: true,
            folder: { select: { name: true, roleId: true, visibility: true } },
            role: { select: { name: true, color: true } },
            createdBy: { select: { id: true, displayName: true } },
          },
        },
      },
    });
    // Filter by canView in case the article became inaccessible
    // since the like (e.g. visibility flipped to private and the
    // user lost role membership).
    const collabIds = await getCollaboratorArticleIds(user.id, likes.map((l) => l.article.id));
    const visible = likes
      // `likedAt` (was `createdAt`) to disambiguate from `row.updatedAt`
      // — the article timestamp lives inside the row; this outer
      // timestamp is when the user clicked like.
      .map((l) => ({ row: toFeedRow(l.article, user, userRoleIds, collabIds), likedAt: l.createdAt.toISOString() }))
      .filter((x) => x.row.permissions.canView);
    return { likes: visible };
  });
}
