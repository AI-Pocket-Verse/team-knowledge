import type {
  AdminActivityType,
  AdminActivityPageResponse,
  AdminDashboardActivity,
  FeedArticleRow,
} from "@team-knowledge/shared";
import { prisma } from "../db.js";
import {
  getArticlePermissions,
  getCollaboratorArticleIds,
  getEffectiveFolderPermissions,
  getUserRoleIds,
} from "../utils/permissions.js";
import type { ArticlePermissions } from "../utils/permissions.js";

// Viewer identity passed through every ACL check below. Always the LOGGED-IN
// caller (NOT the profile's target) — every visibility decision is made
// against what the VIEWER can already see, so a public profile never leaks a
// doc / event the viewer couldn't reach on their own.
export interface Viewer {
  id: string;
  isAdmin: boolean;
}

// Compact feed row for the 发布的文档 tab. Mirrors `toFeedRow` in routes/me.ts
// exactly (same shape, same permission helper chain) but lives here so the
// public-profile route and the service share one definition. Returns a
// FeedArticleRow whose `.permissions.canView` the caller filters on.
function toFeedRow(
  a: {
    id: string;
    title: string;
    folderId: string | null;
    roleId: string;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    folder: { roleId: string; visibility: string; name: string } | null;
    role: { name: string; color: string | null };
    createdBy: { id: string; displayName: string } | null;
  },
  viewer: Viewer,
  userRoleIds: Set<string>,
  collabIds: Set<string>,
): FeedArticleRow {
  const mp = getEffectiveFolderPermissions({
    user: viewer,
    userRoleIds,
    article: { roleId: a.roleId, folder: a.folder },
  });
  const perms = getArticlePermissions({
    folderPermissions: mp,
    article: { createdById: a.createdById },
    userId: viewer.id,
    isAdmin: viewer.isAdmin,
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
  };
}

// GET /api/users/:id/articles — the target's NON-DRAFT (published/archived)
// authored docs, ACL-filtered to the VIEWER. Same query shape + ordering as
// /api/me/feed, scoped to `createdById = targetId` and excluding drafts, then
// run through toFeedRow for the viewer and dropped where !canView (this is
// what enforces role/folder visibility — a target's published doc in a
// private role the viewer isn't in is removed). Capped at 200 rows.
export async function getPublicArticles(
  targetId: string,
  viewer: Viewer,
): Promise<{ articles: FeedArticleRow[] }> {
  const userRoleIds = await getUserRoleIds(viewer.id);
  const rows = await prisma.article.findMany({
    where: { createdById: targetId, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 200,
    select: {
      id: true, title: true, folderId: true, roleId: true, createdById: true,
      createdAt: true, updatedAt: true,
      folder: { select: { name: true, roleId: true, visibility: true } },
      role: { select: { name: true, color: true } },
      createdBy: { select: { id: true, displayName: true } },
    },
  });
  // Collaborator set is keyed on the VIEWER — surfaces a target's doc the
  // viewer can see only via a per-article grant (consistent with /me/feed).
  const collabIds = await getCollaboratorArticleIds(viewer.id, rows.map((r) => r.id));
  const articles = rows
    .map((r) => toFeedRow(r, viewer, userRoleIds, collabIds))
    .filter((r) => r.permissions.canView);
  return { articles };
}

// Map an ArticleVersion.kind to the activity type — identical logic to
// services/activity.ts versionKindToType (restore/archive/unarchive/ai-fix/edit),
// inlined here so the public feed stays in lockstep with the admin one.
function versionKindToType(kind: string): AdminActivityType {
  switch (kind) {
    case "restore": return "doc_restore";
    case "archive": return "doc_archive";
    case "unarchive": return "doc_unarchive";
    case "ai-fix": return "doc_fix";
    default: return "doc_edit";
  }
}

// One pre-serialization public contribution event. Each carries the subject
// article's permission inputs so the viewer-scoped canView gate can run before
// the event is admitted to the feed.
interface PublicEvent {
  id: string;
  at: Date;
  type: AdminActivityType;
  title: string | null;
  article: {
    id: string;
    roleId: string;
    createdById: string | null;
    folder: { roleId: string; visibility: string } | null;
  };
}

// Bound each of the three source queries. Mirrors services/activity.ts'
// SOURCE_CAP intent: read the newest N rows per source so memory stays
// O(cap), not O(corpus). Deep pagination past this is approximate.
const SOURCE_CAP = 500;

// Compute canView for the VIEWER on an event's subject article, using the SAME
// helper chain toFeedRow uses (getEffectiveFolderPermissions with the viewer's
// roleIds → getArticlePermissions). Returns the article's canView for the
// viewer; events whose article isn't viewable are dropped by the caller.
function eventCanView(ev: PublicEvent, viewer: Viewer, viewerRoleIds: Set<string>): boolean {
  const mp = getEffectiveFolderPermissions({
    user: viewer,
    userRoleIds: viewerRoleIds,
    article: { roleId: ev.article.roleId, folder: ev.article.folder },
  });
  const perms: ArticlePermissions = getArticlePermissions({
    folderPermissions: mp,
    article: { createdById: ev.article.createdById },
    userId: viewer.id,
    isAdmin: viewer.isAdmin,
    // Public-feed canView intentionally ignores the viewer's per-article
    // collaborator grants: the feed surfaces only PUBLIC contribution events
    // (non-draft docs), so a doc is viewable here iff its folder/role rules
    // grant it — there are no drafts to need a collaborator override.
  });
  return perms.canView;
}

// GET /api/users/:id/activity — the target's PUBLIC contribution feed,
// ACL-filtered to the VIEWER. Three sources, each authored by the TARGET and
// whose subject doc is live + non-draft:
//   - Article  (createdById = target)              → doc_create
//   - ArticleVersion (authorId = target)           → publish/restore/archive/
//                                                     unarchive/edit
//   - Comment (authorId = target)                  → comment
// Likes / bookmarks / views / chat / uploads / meetings are NOT included (this
// is a public contribution feed, not the admin telemetry stream). Each event's
// subject article visibility is checked against the VIEWER; non-viewable events
// are dropped. Merged, sorted desc, paginated 20/page. Returns the SAME shape
// as api.admin.activity (AdminActivityPageResponse) so the web ActivityFeed
// component can consume it unchanged; userName = the target's displayName.
export async function getPublicActivity(opts: {
  targetId: string;
  targetName: string;
  viewer: Viewer;
  page: number;
}): Promise<AdminActivityPageResponse> {
  const pageSize = 20;
  const { targetId, targetName, viewer, page } = opts;
  const viewerRoleIds = await getUserRoleIds(viewer.id);
  // Bound each source to roughly the rows this page needs plus a one-page
  // buffer, capped at SOURCE_CAP (matches pageActivity in services/activity.ts).
  const take = Math.min(SOURCE_CAP, page * pageSize + pageSize);
  const order = { createdAt: "desc" as const };
  // Article subject selection — shared by all three sources so the viewer
  // canView check has identical inputs (status/roleId/createdById/folder).
  const articleSelect = { id: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } } as const;
  // 去草稿后:所有未删除文档都计入活动来源。version/comment 经 `article` 关系过滤。
  const liveNonDraft = { deletedAt: null } as const;

  const [articles, versions, comments] = await Promise.all([
    prisma.article.findMany({
      where: { createdById: targetId, deletedAt: null },
      select: { id: true, createdAt: true, title: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } },
      orderBy: order,
      take,
    }),
    prisma.articleVersion.findMany({
      where: { authorId: targetId, kind: { not: "import" }, article: liveNonDraft },
      select: { id: true, createdAt: true, kind: true, article: { select: { title: true, ...articleSelect } } },
      orderBy: order,
      take,
    }),
    prisma.comment.findMany({
      where: { authorId: targetId, article: liveNonDraft },
      select: { id: true, createdAt: true, article: { select: { title: true, ...articleSelect } } },
      orderBy: order,
      take,
    }),
  ]);

  const events: PublicEvent[] = [
    ...articles.map((a) => ({
      id: `doc-${a.id}`,
      at: a.createdAt,
      type: "doc_create" as const,
      title: a.title,
      article: { id: a.id, roleId: a.roleId, createdById: a.createdById, folder: a.folder },
    })),
    ...versions.map((v) => ({
      id: `ver-${v.id}`,
      at: v.createdAt,
      type: versionKindToType(v.kind),
      title: v.article.title,
      article: { id: v.article.id, roleId: v.article.roleId, createdById: v.article.createdById, folder: v.article.folder },
    })),
    ...comments.map((c) => ({
      id: `cmt-${c.id}`,
      at: c.createdAt,
      type: "comment" as const,
      title: c.article.title,
      article: { id: c.article.id, roleId: c.article.roleId, createdById: c.article.createdById, folder: c.article.folder },
    })),
  ];

  // Drop events whose subject article the VIEWER can't see, then sort desc.
  const visible = events
    .filter((ev) => eventCanView(ev, viewer, viewerRoleIds))
    // id 作为稳定 tiebreak:同一时刻的事件(如建文档 + 首个版本)排序确定,
    // 避免分页时等时间戳条目在页间抖动。
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));

  const total = visible.length;
  const slice = visible.slice((page - 1) * pageSize, page * pageSize);
  const items: AdminDashboardActivity[] = slice.map((ev) => ({
    id: ev.id,
    userId: targetId,
    userName: targetName,
    type: ev.type,
    title: ev.title,
    at: ev.at.toISOString(),
  }));

  return { items, page, pageSize, total, hasMore: page * pageSize < total };
}
