export interface User {
  id: string;
  /** Email from the platform SSO identity, or null when Feishu didn't
   *  provide one. Used for display + the bootstrap-admin allowlist. */
  email: string | null;
  displayName: string;
  /** Same-origin /uploads/<hash> URL for the user's avatar, or null
   *  when the user hasn't uploaded one (UI falls back to an initial
   *  circle). */
  avatarUrl: string | null;
  isAdmin: boolean;
  isActive: boolean;
  /** Free-text chat preference (≤200 chars) injected as a
   *  `[用户偏好]` block into every chat turn's system prompt. Null
   *  when unset. */
  chatPreference: string | null;
  createdAt: string;
}

export interface ProfileUpdateRequest {
  displayName?: string;
  avatarUrl?: string | null;
  /** Set to a string to update the preference; "" or null clears it. */
  chatPreference?: string | null;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: string;
}

export interface UserWithRoles extends User {
  roles: Role[];
}

export interface RoleWithMembers extends Role {
  memberCount: number;
}

export interface MeResponse {
  user: User | null;
  /** 助手显示名（服务端 ASSISTANT_NAME 配置，默认 "AI"）。 */
  assistantName: string;
}

export interface ApiError {
  error: string;
  message: string;
}

// Admin: users. Users self-provision via SSO JIT on first login; admins
// no longer create accounts (no passwords). Admin management is limited
// to assigning roles / admin / active state on users that have appeared.
export interface AdminUserUpdateRequest {
  // displayName is SSO-sourced (read-only); admins edit only admin/active/roles.
  isAdmin?: boolean;
  isActive?: boolean;
  roleIds?: string[];
}

export interface AdminUserUpdateResponse {
  user: UserWithRoles;
}

export interface AdminUserListResponse {
  users: UserWithRoles[];
}

// Admin: data dashboard (看板). Daily per-user operation activity +
// platform-wide common stats. "Operations" are content writes aggregated
// from existing rows (doc create/edit, comment, like, bookmark, upload,
// meeting, chat question); daily-active is from UserActiveDay (covers pure
// browsing too). See routes/admin-dashboard.ts.
export type AdminActivityType =
  | "doc_create"
  | "doc_edit"
  | "doc_restore"
  | "doc_archive"
  | "doc_unarchive"
  | "comment"
  | "like"
  | "bookmark"
  | "upload"
  | "meeting"
  | "chat"
  | "doc_fix"
  | "comment_like"
  | "automation_create"
  | "meeting_comment"
  | "folder_create"
  | "editor_grant";

export interface AdminDashboardOverview {
  totalUsers: number;
  activeToday: number;
  active7d: number;
  newUsers7d: number;
  /** 全部未删除文档总数(去状态后不再区分已发布/草稿)。 */
  docs: number;
  comments: number;
  meetings: number;
  chatMessages: number;
}

export interface AdminDashboardUserRow {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  isActive: boolean;
  roles: string[];
  createdAt: string;
  /** Last authenticated request (throttled stamp); null = never seen since rollout. */
  lastSeenAt: string | null;
  opsToday: number;
  ops7d: number;
  /** Per-day operation counts over the window, oldest → newest (length = days). */
  daily: number[];
}

export interface AdminDashboardActivity {
  id: string;
  userId: string;
  userName: string;
  type: AdminActivityType;
  /** Target title where available (article / meeting); null otherwise. */
  title: string | null;
  at: string;
}

export interface AdminDashboardResponse {
  days: number;
  /** "MM-DD" labels over the window, oldest → newest (length = days). */
  dayLabels: string[];
  overview: AdminDashboardOverview;
  users: AdminDashboardUserRow[];
}

// Paginated activity feed — GET /api/admin/activity. Without `userId` it's
// the platform-wide recent feed; with `userId` it's one user's detailed
// dynamics. 10 items per page.
export interface AdminActivityPageResponse {
  items: AdminDashboardActivity[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

// ─── Admin analytics(数据看板图表)— GET /api/admin/analytics?days=N ───
// All arrays are oldest → newest, length === days. Counts are platform-wide
// (whole knowledge base). See routes/admin-analytics.ts + services/analytics.ts.
export interface AnalyticsTrends {
  /** "MM-DD" labels over the window, oldest → newest (length = days). */
  dayLabels: string[];
  docCreate: number[];
  docEdit: number[];
  comment: number[];
  like: number[];
  bookmark: number[];
  upload: number[];
  chat: number[];
  meeting: number[];
  /** Distinct daily-active users per day (from UserActiveDay). */
  activeUsers: number[];
}

export interface AnalyticsComposition {
  byRole: { roleId: string; roleName: string; count: number }[];
  byInteraction: { key: "like" | "comment" | "bookmark"; count: number }[];
  /** Upload.mimeType bucketed into image / document / other. */
  byUpload: { key: "image" | "document" | "other"; count: number }[];
}

export interface AnalyticsRankings {
  /** 窗口内综合热度排行(不再是全部时间累计浏览)。
   *  score = 独立浏览人数×1 + 点赞×2 + 评论×3 + 收藏×2;
   *  viewers/likes/comments/bookmarks 为构成明细(均为窗口内)。 */
  hotDocs: {
    articleId: string; title: string; score: number;
    viewers: number; likes: number; comments: number; bookmarks: number;
  }[];
  /** Top contributors by weighted contribution over the window. `ops` = raw
   *  operation count; `contribution` = 加权 + 近因衰减后的活跃分(含被认可加分),
   *  排序按后者。`breakdown` = 本窗口各类操作次数(明细 tooltip 用),`received` =
   *  被认可加分(点赞/收藏/评论赞)。 */
  topContributors: {
    userId: string; userName: string; ops: number; contribution: number;
    breakdown: { type: AdminActivityType; count: number }[]; received: number;
  }[];
  docsByRole: { roleId: string; roleName: string; count: number }[];
  /** RoleSkill.status distribution — empty | stale | generating | fresh | failed. */
  skillStatus: { status: string; count: number }[];
}

export interface AdminAnalyticsResponse {
  days: number;
  trends: AnalyticsTrends;
  composition: AnalyticsComposition;
  rankings: AnalyticsRankings;
}

// SSE wire payload for `event: activity` on GET /api/admin/dashboard/stream.
export interface DashboardStreamActivity {
  items: AdminDashboardActivity[];
}

// ─── Role-skill summary for the chat @ Skills picker ───
// GET /api/roles/skill-summary — the caller's roles (admins: all) + whether
// each role's skill is usable (has generated content) so the picker can grey
// out + disable roles with no skill yet.
export interface RoleSkillSummaryItem {
  roleId: string;
  roleName: string;
  /** empty | stale | generating | fresh | failed */
  status: string;
  /** True when the skill has generated content → selectable in the chat picker. */
  usable: boolean;
}
export interface RoleSkillSummaryResponse {
  skills: RoleSkillSummaryItem[];
}

// Admin: roles
export interface RoleCreateRequest {
  name: string;
  description?: string | null;
  color?: string | null;
}

export interface RoleUpdateRequest {
  name?: string;
  description?: string | null;
  color?: string | null;
}

export interface RoleListResponse {
  roles: RoleWithMembers[];
}

export interface RoleMutationResponse {
  role: RoleWithMembers;
}

// Folders + Workspace

export type FolderVisibility = "public" | "private";

export interface Folder {
  id: string;
  name: string;
  description: string | null;
  roleId: string;
  /** Null = 顶层目录;非空 = 该顶层目录的子目录(最多两级)。 */
  parentId: string | null;
  visibility: FolderVisibility;
  templateType: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderPermissions {
  canView: boolean;
  canEdit: boolean;
  isReadOnly: boolean;
}

export interface FolderSummary extends Folder {
  permissions: FolderPermissions;
}

export interface FolderWithRole extends FolderSummary {
  role: Role;
  createdBy: { id: string; displayName: string } | null;
}

export interface WorkspaceRole extends Role {
  ownership: "owned" | "readonly";
  folderCount: number;
  /** 当前用户是否把该角色个人置顶(每人各自;置顶的浮到边栏最顶)。 */
  pinned: boolean;
}

export interface WorkspaceRoleListResponse {
  roles: WorkspaceRole[];
}

export interface WorkspaceFolderListResponse {
  folders: FolderSummary[];
}

export interface WorkspaceFolderResponse {
  folder: FolderWithRole;
}

export interface FolderCreateRequest {
  name: string;
  description?: string | null;
  visibility: FolderVisibility;
  roleId: string;
  /** 省略 / null = 顶层目录;传顶层目录 id = 在其下建子目录(深度封顶 2)。 */
  parentId?: string | null;
}

export interface FolderUpdateRequest {
  name?: string;
  description?: string | null;
  visibility?: FolderVisibility;
  roleId?: string;
  /** Reparent: a top-level folder id = nest under it; null = promote to
   *  top-level; omitted = leave parent unchanged. */
  parentId?: string | null;
}

export interface FolderMutationResponse {
  folder: FolderWithRole;
}

// Articles + Bookmarks

export interface Article {
  id: string;
  title: string;
  contentMarkdown: string;
  // `folderId` is optional. A null value means the doc is "role-direct"
  // — it hangs at the role level in the sidebar tree, outside any folder.
  folderId: string | null;
  // Always set: every doc lives under exactly one role. Used by the
  // sidebar tree, role-page feeds, and role-direct permission checks.
  roleId: string;
  // Drag-reorder position among siblings (same folder, or same
  // role-direct level). Lower = earlier in the rail.
  sortOrder: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArticlePermissions {
  canView: boolean;
  canEdit: boolean;
  canBookmark: boolean;
  canCite: boolean;
  canExport: boolean;
  // True for the article's author + admins — they can manage the
  // per-article editor ACL (add / remove collaborators). False for
  // collaborators themselves, who hold canEdit but cannot re-grant.
  canManageEditors: boolean;
  isReadOnly: boolean;
}

// One row of the per-article editor ACL — returned by
// GET /api/articles/:id/editors. Excludes server-internal fields
// (password hash etc.); just enough to render an avatar + name +
// "added by you on …" line in the management dialog.
export interface ArticleEditor {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  grantedAt: string;
  grantedBy: string | null;
}

export interface ArticleEditorListResponse {
  editors: ArticleEditor[];
}

export interface ArticleEditorAddResponse {
  editor: Pick<ArticleEditor, "userId" | "displayName" | "avatarUrl">;
}

// Slim user record returned by GET /api/users/search — used by the
// "add collaborator" autocomplete. Email is intentionally omitted: the
// search matches on displayName only and never returns email, so the
// endpoint can't be used to enumerate the org's email directory.
export interface UserSearchResult {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface UserSearchResponse {
  users: UserSearchResult[];
}

// Public per-user profile — GET /api/users/:id. Viewable by any logged-in
// user. Identity only (avatar / displayName / role NAMES / join date /
// published-doc count); email is NEVER exposed here (PII). The 发布的文档
// and 动态 tabs are served by separate ACL-filtered endpoints
// (GET /api/users/:id/articles → FeedResponse, GET /api/users/:id/activity
// → AdminActivityPageResponse).
export interface PublicUserProfileResponse {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** Role display NAMES (via UserRole→Role), not ids. */
  roles: string[];
  /** ISO 8601 join date (User.createdAt). */
  createdAt: string;
  /** Count of the target's non-draft (published/archived) live docs. */
  publishedCount: number;
}

// Returned by GET /api/me/collaborations — articles the caller can
// edit via the per-article ACL (NOT articles they authored).
export interface CollaborationRow {
  grantedAt: string;
  article: {
    id: string;
    title: string;
    folderId: string | null;
    folderName: string | null;
    roleId: string;
    roleName: string;
    roleColor: string | null;
    createdById: string | null;
    createdBy: { id: string; displayName: string } | null;
    createdAt: string;
    updatedAt: string;
    permissions: ArticlePermissions;
  };
}

// ---- Folders / Docs tree (sidebar data source) ----
// "Doc" = Article (existing types kept for back-compat with code that
// still talks about Articles; new code prefers Doc for the role's
// sidebar surfaces).

export interface FolderRow {
  id: string;
  name: string;
  description: string | null;
  roleId: string;
  /// Null = top-level folder; non-null = parent folder id (a subfolder).
  parentId: string | null;
  visibility: FolderVisibility;
  templateType: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: FolderPermissions;
  /// Docs that live inside this folder, ordered by sortOrder.
  articles: SlimDoc[];
  /// Subfolders nested under this folder, each carrying its own `articles`.
  /// Only top-level folders have children populated; a subfolder's `children`
  /// is always an empty array (depth is capped at 2).
  children: FolderRow[];
}

export type ReviewStatus = "none" | "pending" | "ok" | "issues" | "dismissed";
export type ReviewCategory = "logic" | "clarity" | "format" | "completeness" | "consistency";
export type ReviewSeverity = "high" | "med" | "low";
export interface ReviewFinding {
  category: ReviewCategory;
  severity: ReviewSeverity;
  problem: string;
  suggestion: string;
  hash: string;
}

export interface SlimDoc {
  id: string;
  title: string;
  /// Null when the doc is role-direct (rendered at the role level,
  /// outside any folder).
  folderId: string | null;
  roleId: string;
  sortOrder: number;
  createdById: string | null;
  // Author displayName surfaced for list/feed rows. Null when the
  // user was hard-deleted.
  createdBy: { id: string; displayName: string } | null;
  updatedAt: string;
  permissions: ArticlePermissions;
  /// AI 入库前置校验状态(none/pending/ok/issues/dismissed)。边栏对 issues 且有
  /// 编辑权限的节点显示红色感叹号。Task 17 收紧为 ReviewStatus。
  reviewStatus: ReviewStatus;
}

export interface WorkspaceTreeResponse {
  folders: FolderRow[];
  directArticles: SlimDoc[];
}

// ---- Article create / move / reorder / import ----
export interface ArticleMoveRequest {
  /// Target folder. `null` = move to role-direct (no folder wrap).
  targetFolderId: string | null;
}

export interface ArticleMoveResponse {
  article: { id: string; folderId: string | null; sortOrder: number };
}

export interface ArticleReorderRequest {
  roleId: string;
  /// `null` = reorder role-direct siblings; provide a folderId to
  /// reorder docs inside that folder.
  folderId?: string | null;
  ids: string[];
}

export interface FolderReorderRequest {
  roleId: string;
  /** 要重排的同级分组:null / 省略 = 顶层目录;否则 = 某顶层目录的子目录组。 */
  parentId?: string | null;
  ids: string[];
}

export type FolderDeleteOnContent = "move" | "cascade";

export interface CollaborationsResponse {
  collaborations: CollaborationRow[];
}

/**
 * List-shaped article — used by `GET /api/folders/:folderId/articles` and
 * the bookmarks list response. Intentionally omits `contentMarkdown` so
 * those endpoints don't transmit potentially-MB-sized bodies for every row.
 * Use ArticleWithRelations (returned by detail/mutation endpoints) when you
 * need the body.
 */
export interface ArticleSummary extends Omit<Article, "contentMarkdown"> {
  permissions: ArticlePermissions;
  createdBy: { id: string; displayName: string } | null;
  isBookmarked: boolean;
  /** Plain-text excerpt (~140 chars) of the body. Only set by the
   *  list endpoint; detail responses leave it undefined. */
  preview?: string;
  /** URL of the first image referenced in the body (relative or
   *  absolute). Only set by the list endpoint. */
  firstImage?: string | null;
  /** Total like count for this article. */
  likeCount: number;
  /** Whether the current viewer has liked this article. */
  isLiked: boolean;
  /** Total comment count for this article. */
  commentCount: number;
  /** Total bookmark count for this article. Optional — list endpoints
   *  that already skip `likeCount`/`commentCount` for response-size
   *  reasons (e.g. GET /api/bookmarks) don't populate it either; the
   *  detail endpoint and bookmark mutation endpoints do. */
  bookmarkCount?: number;
}

export interface CommentRow {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string } | null;
  canDelete: boolean;
  /// Null for top-level comments; set to the parent's id for replies.
  /// The GET endpoint returns top-level comments only — replies are
  /// nested under `replies` on each one — so client code can render
  /// the thread without re-grouping the flat list.
  parentId: string | null;
  likeCount: number;
  isLiked: boolean;
  /// Only populated on top-level comments. Always present (empty
  /// array when no replies) so callers don't need to null-check.
  replies: CommentRow[];
}

// Slim article row used by personal-page tab lists (我的文章 / 我的点赞).
// Drops contentMarkdown / preview / firstImage to keep the response
// small — the tab UI only needs a clickable navigation row.
export interface FeedArticleRow {
  id: string;
  title: string;
  // folderId/folderName are null for role-direct docs (no folder
  // wrap). The row UI shows the role name as the breadcrumb when
  // the doc is role-direct.
  folderId: string | null;
  folderName: string | null;
  roleId: string;
  roleName: string;
  roleColor: string | null;
  createdAt: string;
  updatedAt: string;
  // Author of the doc — surfaced in feed/list rows so the reader
  // sees who's responsible without opening the article. Null when
  // the user was hard-deleted.
  createdBy: { id: string; displayName: string } | null;
  permissions: ArticlePermissions;
  /// AI 入库前置校验状态。feed 行据此(且有编辑权限时)显示待优化感叹号。
  reviewStatus?: ReviewStatus;
}

export interface MyArticlesResponse {
  articles: FeedArticleRow[];
}

export interface MyLikesResponse {
  likes: { row: FeedArticleRow; likedAt: string }[];
}

// Cross-folder time-flow used by the home page / role page / folder
// page. Server applies role-based visibility filtering. Same row shape
// as MyArticlesResponse so the UI can share rendering.
export interface FeedResponse {
  articles: FeedArticleRow[];
}

export interface InboundRef {
  id: string;
  title: string;
  // Null when the referencing doc is role-direct (no folder wrap).
  folderId: string | null;
  roleId: string;
}

export interface ArticleWithRelations extends ArticleSummary {
  contentMarkdown: string;
  // Null when this doc is role-direct (hangs under a Role with no
  // folder wrap). Consumers must null-check before reading folder.name.
  folder: Folder | null;
  role: Role;
  inboundRefs: InboundRef[];
  versionsCount: number;
}

// Creating a doc requires a `roleId`. `folderId` is optional: omit it
// to drop the doc directly under the role (role-direct), or provide a
// folder id to drop it inside that folder.
export interface ArticleCreateRequest {
  roleId: string;
  folderId?: string | null;
  title: string;
  contentMarkdown: string;
}

export interface ArticleUpdateRequest {
  title?: string;
  contentMarkdown?: string;
  /** Optimistic lock — pass the article's current updatedAt; server
   *  rejects with 409 if it has moved. Client should re-fetch on 409. */
  expectedUpdatedAt?: string;
}

export type ArticleBulkAction = "delete";
export interface ArticleBulkRequest {
  action: ArticleBulkAction;
  ids: string[];
}
export interface ArticleBulkResponse {
  ok: string[];
  failed: { id: string; reason: string }[];
}

export interface ArticleVersion {
  id: string;
  articleId: string;
  title: string;
  contentMarkdown: string;
  authorId: string | null;
  authorDisplayName: string | null;
  createdAt: string;
}

export interface ArticleVersionListResponse {
  versions: ArticleVersion[];
}

// One viewer entry in the doc-detail "谁看过" list. Returned only to
// privileged viewers (author / admin / collaborator) — see
// ArticleViewsResponse.canSeeViewers.
export interface ArticleViewer {
  user: { id: string; displayName: string; avatarUrl: string | null };
  /** ISO timestamp of this viewer's most recent view. */
  lastViewedAt: string;
  /** How many distinct (de-duped per 30 min) views this user made. */
  viewCount: number;
}

// GET /api/articles/:id/views — read-tracking aggregate for the
// doc-detail dialog. `viewers` is null when the caller isn't allowed to
// see the per-user list (canSeeViewers false); the aggregate pv /
// uniqueViewers counts are always returned.
export interface ArticleViewsResponse {
  /** Total page views = SUM(viewCount) across all viewer rows. */
  pv: number;
  /** Distinct viewers = COUNT(rows). */
  uniqueViewers: number;
  /** True when the caller (author / admin / collaborator) may see the
   *  per-viewer list. */
  canSeeViewers: boolean;
  /** Viewer list ordered by lastViewedAt desc; null when !canSeeViewers. */
  viewers: ArticleViewer[] | null;
}

export interface ArticleSearchHit {
  id: string;
  title: string;
  // folderId/folderName are null for role-direct docs (no folder).
  folderId: string | null;
  folderName: string | null;
  roleId: string;
  roleName: string;
  roleColor: string | null;
  // 最近更新时间(ISO)+ 最后修改人显示名(最近一条版本作者,缺省回退创建者)。
  // 用于结果行副标题「{editorName} 在 X 修改过」,与最近浏览行同款。旧调用方
  // 兼容:为新增可选字段。
  updatedAt?: string;
  editorName?: string | null;
}

export interface ArticleSearchResponse {
  hits: ArticleSearchHit[];
}

// 顶栏搜索弹窗「最近浏览」——当前用户最近打开过、仍有权限查看的文档。
// 复用 ArticleView.lastViewedAt 排序,字段与 ArticleSearchHit 对齐外,
// 额外带 lastViewedAt(本人打开时间),且 updatedAt/editorName 必返回。
export interface RecentViewHit {
  id: string;
  title: string;
  folderId: string | null;
  folderName: string | null;
  roleId: string;
  roleName: string;
  roleColor: string | null;
  /** 当前用户最近一次打开该文档的时间(ISO)。 */
  lastViewedAt: string;
  /** 文档最近更新时间(ISO)。 */
  updatedAt: string;
  /** 最后修改人显示名(最近一条版本作者,缺省回退创建者)。 */
  editorName: string | null;
}

export interface ArticleRecentViewsResponse {
  hits: RecentViewHit[];
}

export interface Bookmark {
  userId: string;
  articleId: string;
  createdAt: string;
}

export interface BookmarkListResponse {
  bookmarks: { article: ArticleWithRelations; createdAt: string }[];
  /** True when the user has more bookmarks past the server cap.
   *  See ArticleListResponse.hasMore for the same pattern. */
  hasMore: boolean;
}

export interface ArticleListResponse {
  articles: ArticleSummary[];
  /** True when the folder has more articles past the server cap.
   *  The UI can surface a "still more articles" hint or implement
   *  load-more pagination using the `take` query param. */
  hasMore: boolean;
}

export interface ArticleResponse {
  article: ArticleWithRelations;
}

export interface ArticleMutationResponse {
  article: ArticleWithRelations;
}

export interface ImageUploadResponse {
  url: string;
  bytes: number;
}

export interface FileUploadResponse {
  url: string;
  filename: string;
  originalName: string;
  bytes: number;
  mimeType: string;
}

// AI chat
export type ChatRole = "user" | "assistant";

/** A [#N] citation target sufficient to render the badge as a link.
 *  Server fills this in on GET /api/chat/conversation so historical
 *  messages keep working after a page refresh. folderId is null for
 *  role-direct docs (no folder wrap). */
export interface CitationRef {
  n: number;
  articleId: string;
  title: string;
  folderId: string | null;
  roleId: string;
}

/** Structured @-mention payload carried alongside a user chat message.
 *  Wire shape (client → server): `{ type, id }` only — server resolves
 *  `label` from the database to defeat client-side tampering. Wire shape
 *  (server → client, persisted history): full `{ type, id, label }` so
 *  the chip can render even if the underlying doc/folder/role is later
 *  renamed or deleted. */
export type MentionType = "doc" | "folder" | "role" | "skill";
export interface MentionRef {
  type: MentionType;
  id: string;
  label: string;
}

export interface ChatMessageRow {
  id: string;
  role: ChatRole;
  content: string;
  /** JSON-decoded list of article ids the assistant cited. Always
   *  present (empty array if none) so callers don't need to null-check. */
  citedArticleIds: string[];
  /** Resolved citation targets (title + role/folder for routing). Server
   *  populates for assistant messages whose articles still exist + the
   *  caller can see; missing entries mean the article was deleted or the
   *  user lost access. */
  citedRefs: CitationRef[];
  /** Structured @-mentions the user attached to this message. Empty
   *  array for assistant messages and for user messages that didn't
   *  use the chip selector. */
  mentions: MentionRef[];
  /** 随消息上传的图片(/uploads/<file> 视图)。仅用户消息可能非空;旧行与
   *  assistant 行为空数组/缺省。 */
  images?: string[];
  /** Extended-thinking trace captured during this assistant turn.
   *  Three states:
   *    - undefined: no thinking happened (non-thinking model OR
   *      simple question that didn't trigger reasoning)
   *    - "": thinking happened but the CLI only surfaced the
   *      signature (no raw reasoning text leaked). UI shows a
   *      "已深度思考" badge without an expandable body.
   *    - non-empty string: incremental thinking text accumulated
   *      from thinking_delta events. UI shows a collapsible card.
   *  Runtime-only — NOT persisted server-side, so messages reloaded
   *  via /api/chat/conversation always come back undefined here.
   *  Only the in-flight reply and the messages in the current
   *  browser session carry thinking. */
  thinking?: string;
  /** True when the user clicked the stop button mid-stream on this
   *  user message. The bubble then renders a leading ⚠ icon as a
   *  visual cue that the turn didn't complete. Runtime-only — not
   *  persisted, so the marker is per-session (matches the partial-
   *  reply behavior: the server saves whatever streamed before the
   *  abort, but the "interrupted" flag lives only in this tab). */
  aborted?: boolean;
  createdAt: string;
}

export interface ConversationResponse {
  id: string;
  messages: ChatMessageRow[];
  /** Rolling LLM-generated summary of older turns; null until the
   *  background summarizer's first refresh. Surfaced so the UI can
   *  fold messages preceding `summaryUpToMessageId` into a collapsed
   *  "之前对话(已总结)" block. */
  summary: string | null;
  /** Id of the last ChatMessage whose content is already captured in
   *  `summary`. Messages with this id or older are foldable. */
  summaryUpToMessageId: string | null;
  /** When the summary was last refreshed (ISO 8601). Null if no
   *  refresh has run yet. */
  summaryUpdatedAt: string | null;
  /** 是否还有比当前返回的最早一条更早的消息(上滑懒加载判据)。 */
  hasMoreOlder: boolean;
  /** 会话标题(null=未命名)。 */
  title?: string | null;
  /** 是否为飞书专用会话。 */
  isFeishu?: boolean;
}

/** 会话列表项(GET /api/chat/conversations)。 */
export interface ConversationListItem {
  id: string;
  title: string | null;
  isFeishu: boolean;
  /** 用户是否置顶该会话(列表里排在飞书之下、普通会话之上)。 */
  pinned: boolean;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ConversationListResponse {
  items: ConversationListItem[];
  hasMore: boolean;
}

export type LlmProviderId = "claude" | "codex";

export interface LlmProviderStatus {
  current: LlmProviderId;
  available: {
    claude: { ok: boolean; reason?: string; version?: string };
    codex:  { ok: boolean; reason?: string; version?: string };
  };
  /** 多人模式(已配 WHOAMI_URL)为 false：codex 带 shell 工具，服务端拒绝切换。 */
  codexAllowed: boolean;
}

export interface LlmProviderUpdateRequest {
  provider: LlmProviderId;
}

// CLI 可执行文件路径设置。systemd 的精简 PATH 找不到 nvm 里的 claude/codex 时,
// 管理员可在系统设置填绝对路径。null = 未配置(回退 env/PATH)。
// `available` 与 LlmProviderStatus.available 同构,保存后即时回显探测结果。
export interface LlmBinarySettings {
  claudePath: string | null;
  codexPath: string | null;
  available: {
    claude: { ok: boolean; reason?: string; version?: string };
    codex:  { ok: boolean; reason?: string; version?: string };
  };
}

// 各引擎使用的模型 ID。优先级：后台设置(claude / codex) > .env(envDefault) > CLI 默认模型。
// active 为当前生效值，null = 不传模型参数，用 CLI 默认模型。
export interface LlmModelSettings {
  claude: string | null;
  codex: string | null;
  envDefault: { claude: string | null; codex: string | null };
  active: { claude: string | null; codex: string | null };
}

export interface LlmModelUpdateRequest {
  /** 省略=不改动;null 或空串=清除;模型 ID=设置。 */
  claude?: string | null;
  codex?: string | null;
}

export interface LlmBinaryUpdateRequest {
  /** 省略=不改动;null 或空串=清除;绝对路径字符串=设置。 */
  claudePath?: string | null;
  codexPath?: string | null;
}

// ───助手会议 ──────────────────────────────────────────────
// Status of a meeting session. "active" while the host has it open
// (audio streaming); "ended" after host stops or it auto-ends
// past the duration hint.
export type MeetingStatus = "active" | "ended";

// Why assistant chimed in for a given comment. Used both for analytics
// + for the timeline icons in the post-meeting summary.
export type MeetingCommentTrigger =
  | "explicit_wake"   // someone said a configured wake word (WAKE_WORDS) in transcript
  | "keyword"          // detected "我们以前/上次..." style references
  | "silence"          // 12s+ silent + unanswered question on the floor
  | "proactive"        // enough new discussion accrued → unprompted comment
  | "manual_button"    // host pressed "📢 让助手评论刚才"
  | "user_question";   // any participant typed via "💬 问助手"

// Per-session knobs the admin picks at create time + can tweak live.
// Serialized as JSON in MeetingSession.config so adding fields here
// doesn't need a schema migration.
export interface MeetingConfig {
  /** Auto play assistant's comments as voice on the host's device speaker. */
  tts: boolean;
  /** Save the host's mic audio stream to OSS for post-meeting playback. */
  recording: boolean;
  /** Sliding-window throttle: assistant may emit at most
   *  `freqLimitMessages` natural-trigger comments within the last
   *  `freqLimitMinutes` minutes. Explicit wake / manual button /
   *  user question always bypass this. Setting messages=1 reproduces
   *  the original "one comment per N minutes" behavior. */
  freqLimitMinutes: number;
  freqLimitMessages: number;
  /** Wake up assistant when discussion stalls past 12s + last sentence
   *  looked like an open question. Defaults to ON (user picked D). */
  triggerSilence: boolean;
  /** Trigger on "我们以前/上次..." style references that suggest the
   *  conversation could benefit from a doc lookup. Defaults to ON. */
  triggerKeyword: boolean;
  /** Proactively chime in once enough NEW discussion accrues since
   *  assistant's last comment (≥6 new finals OR ≥45s of speech), with its
   *  own ≥60s cadence independent of the keyword/silence throttle.
   *  Defaults to ON. */
  triggerProactive: boolean;
  /** Soft cap for the session. UI prompts the host to renew at this
   *  many hours. Defaults to 4 (user picked C). */
  durationHintHours: number;
  /** Voice / wording style for assistant's chimes. "neutral" matches the
   *  web assistant. */
  style: "neutral" | "concise" | "verbose";
}

// What POST /api/meeting takes. allowedRoleIds is OPTIONAL now (empty/omitted ⇒
// assistant retrieves public docs only). visibility defaults to "public" server-side.
export interface MeetingCreateRequest {
  title: string;
  allowedRoleIds?: string[];
  visibility?: FolderVisibility;
  config: MeetingConfig;
}

// What PATCH /api/meeting/:id takes — edit visibility and/or title after
// creation (creator or admin). At least one field must be present.
export interface MeetingUpdateRequest {
  title?: string;
  visibility?: FolderVisibility;
}

// Sentinel prefix written to MeetingSession.summaryMarkdown when
// generation fails (LLM returned empty, threw, timed out, etc).
// Persisting a marker — rather than leaving the field null — lets
// the polling UI bail out of the "generating..." state immediately
// instead of waiting the full 90s for the client-side timeout.
// The substring after the prefix is the reason code (empty_reply /
// llm_failed / ...). UI strips this so it never renders to users.
export const MEETING_SUMMARY_FAILED_PREFIX = "__MEETING_SUMMARY_FAILED__::";

export function isMeetingSummaryFailure(markdown: string | null | undefined): boolean {
  return !!markdown && markdown.startsWith(MEETING_SUMMARY_FAILED_PREFIX);
}

// A single MeetingSession row + a few denormalized fields so the
// hub list and the live room don't both have to re-query.
export interface MeetingSessionRow {
  id: string;
  title: string;
  status: MeetingStatus;
  /** Audience scope: "public" = any logged-in user; "private" = creator + admins. */
  visibility: FolderVisibility;
  /** Host's user id (the admin who created the meeting). */
  hostUserId: string;
  /** Host's displayName at the time we joined for display. */
  hostName: string;
  allowedRoleIds: string[];
  /** Resolved role display names + colors, in the same order as
   *  allowedRoleIds. Built server-side so the UI doesn't need to
   *  cross-reference the role catalog. Length may be < allowedRoleIds
   *  if a role got deleted post-meeting. */
  allowedRoles: { id: string; name: string; color: string | null }[];
  config: MeetingConfig;
  createdAt: string;
  endedAt: string | null;
  recordingUrl: string | null;
  summaryMarkdown: string | null;
}

// One finalized STT segment. partials are NOT persisted, see schema.
export interface MeetingTranscriptRow {
  id: string;
  /** Plain text. */
  text: string;
  /** Offset from MeetingSession.createdAt in ms. */
  startMs: number;
  endMs: number;
  /** STT diarization label when available; null in single-mic v1. */
  speaker: string | null;
  createdAt: string;
}

// One assistant chime. citedArticleIds is decoded for the UI (server
// stores it as JSON string in the row, REST layer parses).
export interface MeetingCommentRow {
  id: string;
  triggerType: MeetingCommentTrigger;
  /** For manual_button / user_question, who triggered it. */
  triggeredByUserId: string | null;
  triggeredByName: string | null;
  text: string;
  citedArticleIds: string[];
  /** Resolved cited docs (id + title) for the clickable links rendered
   *  after the comment. Server resolves titles for docs that still exist,
   *  so this may be SHORTER than citedArticleIds when a cited doc was
   *  deleted. Empty array when nothing was cited. */
  citedRefs: { articleId: string; title: string }[];
  ttsAudioUrl: string | null;
  /** Offset from MeetingSession.createdAt in ms. */
  atMs: number;
  createdAt: string;
  /** True while this comment's text is still streaming in live over the
   *  WebSocket (set by the `assistant_comment_start`→`assistant_comment_done`
   *  sequence). Undefined for REST-hydrated / finished comments, which
   *  render in their final form. Live TTS for streamed comments is played
   *  sentence-by-sentence (see the meeting WS protocol), not via ttsAudioUrl. */
  streaming?: boolean;
}

// GET /api/meeting/hub  → home page of /meeting. Lists current
// active meetings (any admin in the org may have one) + recent ended
// meetings for quick re-open of summaries.
export interface MeetingHubResponse {
  active: MeetingSessionRow[];
  /** Most-recent-first; default 20, paginated in a later iteration. */
  recent: MeetingSessionRow[];
}

// GET /api/meeting/:id  → the live room / summary view. Includes the
// current persisted transcripts + assistant comments so a refresh / late
// join shows the meeting in-progress. The live deltas after that
// come over the WebSocket.
export interface MeetingDetailResponse {
  session: MeetingSessionRow;
  transcripts: MeetingTranscriptRow[];
  comments: MeetingCommentRow[];
}

// ─── Recycle bin (soft-delete) ─────────────────────────────────────
// One entry in the per-user recycle bin. The bin is PRIVATE: a user
// only sees items THEY deleted. `type` discriminates the shape:
//   - meeting → just the title.
//   - folder  → role + how many docs went into the bin with it.
//   - article → role + (optional) the folder it lived under, by name.
// Articles cascade-deleted with their folder are NOT listed
// individually — they're represented by the folder entry.
export type RecycleBinItem =
  | { type: "meeting"; id: string; title: string; deletedAt: string }
  | {
      type: "folder";
      id: string;
      name: string;
      roleId: string;
      roleName: string;
      /** Count of child articles binned together with this folder. */
      docCount: number;
      deletedAt: string;
    }
  | {
      type: "article";
      id: string;
      title: string;
      roleId: string;
      roleName: string;
      /** Name of the folder it sat in, or null for role-direct docs. */
      folderName: string | null;
      deletedAt: string;
    };

// GET /api/recycle-bin → the caller's own binned items, newest-deleted
// first.
export interface RecycleBinListResponse {
  items: RecycleBinItem[];
}

// ── DB 备份 / 还原(管理后台,仅管理员)─────────────────────────────────
// 备份文件落在 <data>/backups/team-knowledge/(每日 03:00 cron 自动备份)与其
// .../manual/ 子目录(后台手动备份,长期保留、不被 14 天 cron 清理)。
export interface BackupInfo {
  /** 文件名(basename),如 team-knowledge-2026-06-09-143005.db.gz。 */
  name: string;
  /** 绝对路径 —— 用于展示「文件位置」。 */
  path: string;
  /** 字节大小。 */
  sizeBytes: number;
  /** 备份写入时间(ISO 字符串)—— 即「还原事件点」。 */
  createdAt: string;
  /** manual = 后台手动备份(长期保留);auto = 每日 cron 自动备份。 */
  source: "manual" | "auto";
  /** 是否带配套的上传文件(附件/图片)包(<同名>.uploads.tar.gz)。还原时会一并恢复。 */
  hasUploads?: boolean;
  /** 上传文件包大小(字节),hasUploads 时有值。 */
  uploadsSizeBytes?: number;
}

// GET /api/admin/backup → 目录下全部 team-knowledge 备份,按时间倒序。
export interface BackupListResponse {
  backups: BackupInfo[];
}

// POST /api/admin/backup → 立即生成一份手动备份。
export interface BackupCreateResponse {
  backup: BackupInfo;
}

// POST /api/admin/backup/:name/restore → 还原到所选备份。
export interface BackupRestoreResponse {
  ok: true;
  /** 还原前自动生成的安全快照(可据此回滚)。 */
  predo: BackupInfo;
  /** 是否一并还原了上传文件(该备份带配套 uploads 包时为 true)。 */
  uploadsRestored: boolean;
}

// ── 知识库周报(管理后台,仅管理员)──────────────────────────────────────
// 每周一 00:00(北京)定时生成「上一个完整周一–周日」周报。时间一律北京时间。

// 单个用户本周明细(贡献度倒序)。durationMin 为事件跨度启发式估算的在线时长;
// activeDays 为本周有活动的去重天数;view 为本周去重查看文档数(ArticleView 末次
// 查看落在本周)。
export interface WeeklyReportUserRow {
  userId: string;
  name: string;
  durationMin: number;
  activeDays: number;
  docCreate: number;
  docEdit: number;
  chat: number;
  comment: number;
  like: number;
  view: number;
  contribution: number;
  ops: number;
}

// 每个北京自然日(周一→周日)的趋势点。
export interface WeeklyReportTrendPoint {
  day: string; // YYYY-MM-DD(北京)
  docCreate: number;
  docEdit: number;
  comment: number;
  like: number;
  chat: number;
  view: number;
  activeUsers: number;
}

// 行为构成(饼图)。
export interface WeeklyReportCompositionSlice {
  key: string;
  label: string;
  count: number;
}

// 实时动态汇总条目(本周最近若干条)。
export interface WeeklyReportLiveItem {
  at: string; // ISO
  userId?: string; // 用于点击用户名打开活动抽屉(本轮新增 → 旧持久化快照可能缺失)
  name: string;
  type: AdminActivityType | "view";
  label: string;
  title: string | null;
}

// 用户维度:单个用户本周的每日趋势 + 行为构成,供详情页按用户筛选图表。
export interface WeeklyReportUserDimension {
  userId: string;
  name: string;
  trends: WeeklyReportTrendPoint[]; // 7 天(activeUsers 字段对单用户无意义,固定 0)
  composition: WeeklyReportCompositionSlice[];
}

export interface WeeklyReportSnapshot {
  weekKey: string; // 周一北京日期
  weekStart: string; // ISO(UTC 瞬时)
  weekEnd: string; // ISO(右开)
  weekLabel: string; // "2026-06-01 ~ 2026-06-07"(时区口径由展示处上下文说明;历史快照可能仍带「（北京时间）」括注)
  // 本周概览的一段文字描述(后端生成,详情页 + 飞书通知 + 导出共用)。
  // 本轮新增 → 旧持久化快照可能缺失,消费端需判空(详情页已 `s.summary && …`)。
  summary?: string;
  overview: {
    activeUsers: number;
    totalDurationMin: number;
    docCreate: number;
    docEdit: number;
    chat: number;
    comment: number;
    like: number;
    view: number;
    meeting: number;
    bookmark: number;
    upload: number;
    totalOps: number;
  };
  trends: WeeklyReportTrendPoint[]; // 全员聚合
  composition: WeeklyReportCompositionSlice[]; // 全员聚合
  // 每个活跃用户的趋势 + 构成(详情页「用户维度」下拉筛选用)。
  // 本轮新增 → 旧持久化快照可能缺失,消费端用 `?? []` 兜底。
  userDimensions?: WeeklyReportUserDimension[];
  users: WeeklyReportUserRow[];
  topContributors: { userId: string; name: string; contribution: number }[];
  liveActivity: WeeklyReportLiveItem[];
}

// GET /api/admin/weekly-report → 周报列表(按周倒序)。
export interface WeeklyReportListItem {
  id: string;
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  generatedAt: string;
  /** 是否已定稿(快照生成于该周结束之后,generatedAt ≥ weekEnd)。false = 本周进行中,数据随刷新增长。 */
  finalized: boolean;
  activeUsers: number;
  totalOps: number;
  totalDurationMin: number;
}
export interface WeeklyReportListResponse {
  reports: WeeklyReportListItem[];
}

// GET /api/admin/weekly-report/:id → 单份周报全量快照。
export interface WeeklyReportDetailResponse {
  id: string;
  generatedAt: string;
  snapshot: WeeklyReportSnapshot;
}

// POST /api/admin/weekly-report/generate → 生成/刷新上周周报。
export interface WeeklyReportGenerateResponse {
  id: string;
  weekKey: string;
  created: boolean;
}

// 产品更新日志(web 关于页与 api 版本播报共用同一份数据)。
export * from "./changelog.js";
