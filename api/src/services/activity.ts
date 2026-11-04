import type {
  AdminActivityType,
  AdminActivityPageResponse,
  AdminDashboardActivity,
} from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { L, appLang } from "../utils/lang.js";

// One aggregated activity event (pre-serialization). `uid` may be null when
// the actor was hard-deleted (SetNull) — such events count toward platform
// stats but are skipped from per-user buckets / feeds.
export interface ActivityEvent {
  id: string;
  uid: string | null;
  at: Date;
  type: AdminActivityType;
  title: string | null;
}

// Default hard cap per source query. There's no audit-log table, so an
// activity "page" is assembled by reading the latest rows from 8 content
// tables and merging in JS. Without a `take`, each findMany loads EVERY
// row in the window into memory on every dashboard/feed hit — O(corpus)
// memory that grows unbounded with the install. Capping each source at
// this many of the MOST RECENT rows keeps memory bounded regardless of
// corpus size. The newest-N per source is sufficient for the realistic
// first pages of the merged feed; deep pagination past the cap is
// approximate (older events can fall outside the per-source window once
// total events in the window exceed ~cap). The DB indexes on each
// actor/createdAt column make the `orderBy createdAt desc + take` cheap.
const SOURCE_CAP = 500;

// Map an ArticleVersion.kind to the activity type shown in the feed. A version
// row records WHY it was written (set at the create sites in routes/articles.ts):
// restore / archive get their own finer-grained event; anything else
// (incl. legacy "publish" rows from the removed status system, and rows
// backfilled to "edit") is a plain edit.
function versionKindToType(kind: string): AdminActivityType {
  switch (kind) {
    case "restore": return "doc_restore";
    case "archive": return "doc_archive";
    case "unarchive": return "doc_unarchive";
    case "ai-fix": return "doc_fix";
    default: return "doc_edit";
  }
}

// 自动化名、上传原名是用户私有信息（列表按本人隔离），全员可见的动态流里不给他人看到标题。
// 管理员与「按 userId 查某人明细」的出口不受影响；文档 / 公开会议标题本身就是公开内容。
const PRIVATE_TITLE_TYPES: ReadonlySet<AdminActivityType> = new Set(["automation_create", "upload"]);

/** 非管理员看全站动态时抹掉私有类事件的标题（只剩「谁做了什么」）。 */
export function redactPrivateTitle<T extends { type: AdminActivityType; title: string | null }>(e: T): T {
  return PRIVATE_TITLE_TYPES.has(e.type) && e.title !== null ? { ...e, title: null } : e;
}

// Aggregate every content-write into one event stream, optionally scoped to a
// single user. "Operations" = doc create/edit, comment, like, bookmark,
// upload, meeting, chat question — all bucketed from existing row timestamps
// (there is no dedicated audit-log table). Shared by the admin dashboard,
// the admin per-user feed, and the user's own profile 动态 feed.
//
// `take` bounds each of the 8 source queries to the newest N rows so
// memory stays O(take), not O(corpus). Callers that paginate pass a
// page-sized bound; the dashboard (window aggregation) passes the cap.
export async function loadActivityEvents(
  windowStart: Date,
  userId?: string,
  take: number = SOURCE_CAP,
): Promise<ActivityEvent[]> {
  const since = { createdAt: { gte: windowStart } };
  const by = (field: string) => (userId ? { [field]: userId } : {});
  // Take only the newest `take` rows per source, ordered by createdAt desc
  // (matches the merge sort below). Bounds memory per source query.
  const order = { createdAt: "desc" as const };
  // Exclude soft-deleted (recycle-bin) docs/meetings and any event whose
  // subject doc is binned — a binned doc/meeting and its title must not
  // surface in the activity timeline / per-user ops counts. This keeps the
  // feed consistent with the dashboard's overview counts, which already
  // filter `deletedAt: null`. Article-derived events (versions, comments,
  // likes, bookmarks) filter via the `article` relation; uploads and chat
  // questions have no soft-deletable subject doc, so they're unaffected.
  const [articles, versions, comments, likes, bookmarks, uploads, meetings, chats, commentLikes, automations, meetingComments, folders, editorGrants] = await Promise.all([
    prisma.article.findMany({ where: { ...since, deletedAt: null, ...by("createdById") }, select: { id: true, createdById: true, createdAt: true, title: true }, orderBy: order, take }),
    // 导入产生的版本不算「修改文档」：新文档已有 doc_create，覆盖导入也不是用户的一次编辑。
    prisma.articleVersion.findMany({ where: { ...since, kind: { not: "import" }, article: { deletedAt: null }, ...by("authorId") }, select: { id: true, authorId: true, createdAt: true, kind: true, article: { select: { title: true } } }, orderBy: order, take }),
    prisma.comment.findMany({ where: { ...since, article: { deletedAt: null }, ...by("authorId") }, select: { id: true, authorId: true, createdAt: true, article: { select: { title: true } } }, orderBy: order, take }),
    prisma.like.findMany({ where: { ...since, article: { deletedAt: null }, ...by("userId") }, select: { userId: true, articleId: true, createdAt: true, article: { select: { title: true } } }, orderBy: order, take }),
    prisma.bookmark.findMany({ where: { ...since, article: { deletedAt: null }, ...by("userId") }, select: { userId: true, articleId: true, createdAt: true, article: { select: { title: true } } }, orderBy: order, take }),
    prisma.upload.findMany({ where: { ...since, ...by("uploadedById") }, select: { id: true, uploadedById: true, createdAt: true, originalName: true }, orderBy: order, take }),
    // 会议只收公开的:私密会议只有创建者能看,管理员也不例外(与 canViewMeeting 一致)。
    prisma.meetingSession.findMany({ where: { ...since, deletedAt: null, visibility: "public", ...by("createdById") }, select: { id: true, createdById: true, createdAt: true, title: true }, orderBy: order, take }),
    prisma.chatMessage.findMany({
      where: { ...since, role: "user", ...(userId ? { conversation: { userId } } : {}) },
      select: { id: true, createdAt: true, conversation: { select: { userId: true } } },
      orderBy: order,
      take,
    }),
    // 点赞评论:CommentLike(userId, commentId)。评论及其文档均未删。
    prisma.commentLike.findMany({ where: { ...since, comment: { article: { deletedAt: null } }, ...by("userId") }, select: { userId: true, commentId: true, createdAt: true, comment: { select: { article: { select: { title: true } } } } }, orderBy: order, take }),
    // 创建自动化:归属个人(userId)。自动化无软删,删除随用户级联。
    prisma.automation.findMany({ where: { ...since, ...by("userId") }, select: { id: true, userId: true, createdAt: true, name: true }, orderBy: order, take }),
    // 会议内发言/评论:MeetingComment 的操作者是 triggeredByUserId(可空 —— assistant
    // 主动发言无触发人,此时 uid=null,不计入 per-user 桶)。会议(session)未删。
    prisma.meetingComment.findMany({ where: { ...since, session: { deletedAt: null, visibility: "public" }, ...by("triggeredByUserId") }, select: { id: true, triggeredByUserId: true, createdAt: true, session: { select: { title: true } } }, orderBy: order, take }),
    // 新建目录:Folder(createdById 可空 —— 旧数据/系统建的目录无归属,uid=null 不计)。目录未删。
    prisma.folder.findMany({ where: { ...since, deletedAt: null, ...by("createdById") }, select: { id: true, createdById: true, createdAt: true, name: true }, orderBy: order, take }),
    // 加协作者(授权他人编辑):ArticleEditor 的授权者是 grantedBy(可空)、时间戳是 grantedAt
    // (非 createdAt,故单独写 where/order)。文档未删。归属给「授权的人」。
    prisma.articleEditor.findMany({ where: { grantedAt: { gte: windowStart }, article: { deletedAt: null }, ...by("grantedBy") }, select: { articleId: true, userId: true, grantedAt: true, grantedBy: true, article: { select: { title: true } } }, orderBy: { grantedAt: "desc" }, take }),
  ]);
  return [
    ...articles.map((a) => ({ id: `doc-${a.id}`, uid: a.createdById, at: a.createdAt, type: "doc_create" as const, title: a.title })),
    ...versions.map((v) => ({ id: `ver-${v.id}`, uid: v.authorId, at: v.createdAt, type: versionKindToType(v.kind), title: v.article?.title ?? null })),
    ...comments.map((c) => ({ id: `cmt-${c.id}`, uid: c.authorId, at: c.createdAt, type: "comment" as const, title: c.article?.title ?? null })),
    ...likes.map((l) => ({ id: `like-${l.userId}-${l.articleId}`, uid: l.userId, at: l.createdAt, type: "like" as const, title: l.article?.title ?? null })),
    ...bookmarks.map((b) => ({ id: `bm-${b.userId}-${b.articleId}`, uid: b.userId, at: b.createdAt, type: "bookmark" as const, title: b.article?.title ?? null })),
    ...uploads.map((u) => ({ id: `up-${u.id}`, uid: u.uploadedById, at: u.createdAt, type: "upload" as const, title: u.originalName })),
    ...meetings.map((m) => ({ id: `mtg-${m.id}`, uid: m.createdById, at: m.createdAt, type: "meeting" as const, title: m.title })),
    ...chats.map((c) => ({ id: `chat-${c.id}`, uid: c.conversation?.userId ?? null, at: c.createdAt, type: "chat" as const, title: null })),
    ...commentLikes.map((cl) => ({ id: `clike-${cl.userId}-${cl.commentId}`, uid: cl.userId, at: cl.createdAt, type: "comment_like" as const, title: cl.comment?.article?.title ?? null })),
    ...automations.map((a) => ({ id: `auto-${a.id}`, uid: a.userId, at: a.createdAt, type: "automation_create" as const, title: a.name })),
    ...meetingComments.map((mc) => ({ id: `mcmt-${mc.id}`, uid: mc.triggeredByUserId, at: mc.createdAt, type: "meeting_comment" as const, title: mc.session?.title ?? null })),
    ...folders.map((f) => ({ id: `folder-${f.id}`, uid: f.createdById, at: f.createdAt, type: "folder_create" as const, title: f.name })),
    ...editorGrants.map((e) => ({ id: `editor-${e.articleId}-${e.userId}`, uid: e.grantedBy, at: e.grantedAt, type: "editor_grant" as const, title: e.article?.title ?? null })),
  ];
}

// Sort + paginate the event stream into a serialized, name-resolved page.
export async function pageActivity(opts: {
  windowStart: Date;
  userId?: string;
  page: number;
  pageSize: number;
  /** 全站动态（不带 userId）时，仅管理员能看到自动化名 / 上传名。带 userId 的出口已由调用方限定为本人或管理员。 */
  viewerIsAdmin?: boolean;
}): Promise<AdminActivityPageResponse> {
  // Bound each source query to roughly the rows this page needs, plus a
  // one-page buffer, capped at SOURCE_CAP. This keeps memory O(page) for
  // shallow pages (the common case) while never exceeding the hard cap.
  // Deep pages past SOURCE_CAP merged events are approximate (some older
  // events may fall outside a per-source window) — acceptable for an
  // activity feed where users rarely scroll hundreds of pages deep.
  const sourceTake = Math.min(SOURCE_CAP, opts.page * opts.pageSize + opts.pageSize);
  const events = (await loadActivityEvents(opts.windowStart, opts.userId, sourceTake))
    .filter((e) => e.uid)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  // `total` reflects the bounded set, so for windows with more than
  // ~SOURCE_CAP events it is a floor (real total is ≥ this). Shallow
  // pages — the realistic case — report the exact count.
  const total = events.length;
  const slice = events.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);

  const ids = [...new Set(slice.map((e) => e.uid as string))];
  const names = new Map(
    (await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }))
      .map((u) => [u.id, u.displayName]),
  );

  const redact = !opts.userId && !opts.viewerIsAdmin;
  const items: AdminDashboardActivity[] = slice.map((e) => {
    const shown = redact ? redactPrivateTitle(e) : e;
    return {
      id: e.id,
      userId: e.uid as string,
      userName: names.get(e.uid as string) ?? L(appLang(), "（已删除）", "(Deleted)"),
      type: e.type,
      title: shown.title,
      at: e.at.toISOString(),
    };
  });

  return { items, page: opts.page, pageSize: opts.pageSize, total, hasMore: opts.page * opts.pageSize < total };
}
