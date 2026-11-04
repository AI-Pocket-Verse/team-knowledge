import { tr } from "@/i18n";
import type {
  MeResponse,
  User,
  AdminUserUpdateRequest,
  AdminUserUpdateResponse,
  AdminUserListResponse,
  AdminDashboardResponse,
  AdminActivityPageResponse,
  AdminAnalyticsResponse,
  RoleSkillSummaryResponse,
  RoleCreateRequest,
  RoleUpdateRequest,
  RoleListResponse,
  RoleMutationResponse,
  WorkspaceRoleListResponse,
  WorkspaceFolderListResponse,
  WorkspaceFolderResponse,
  FolderCreateRequest,
  FolderUpdateRequest,
  FolderMutationResponse,
  ArticleListResponse,
  ArticleResponse,
  ArticleWithRelations,
  ReviewStatus,
  ReviewFinding,
  ArticleMutationResponse,
  ArticleCreateRequest,
  ArticleUpdateRequest,
  ArticleBulkRequest,
  ArticleBulkResponse,
  ArticleVersionListResponse,
  ArticleViewsResponse,
  ArticleSearchResponse,
  ArticleRecentViewsResponse,
  ArticleEditorListResponse,
  ArticleEditorAddResponse,
  UserSearchResponse,
  PublicUserProfileResponse,
  CollaborationsResponse,
  Bookmark,
  BookmarkListResponse,
  CommentRow,
  FileUploadResponse,
  ImageUploadResponse,
  MyArticlesResponse,
  MyLikesResponse,
  FeedResponse,
  ProfileUpdateRequest,
  ConversationResponse,
  ConversationListItem,
  ConversationListResponse,
  LlmProviderStatus,
  LlmProviderUpdateRequest,
  LlmBinarySettings,
  LlmBinaryUpdateRequest,
  LlmModelSettings,
  LlmModelUpdateRequest,
  WorkspaceTreeResponse,
  ArticleMoveResponse,
  ArticleReorderRequest,
  FolderReorderRequest,
  FolderDeleteOnContent,
  MeetingCreateRequest,
  MeetingUpdateRequest,
  MeetingHubResponse,
  MeetingDetailResponse,
  MeetingSessionRow,
  RecycleBinListResponse,
  BackupListResponse,
  BackupCreateResponse,
  BackupRestoreResponse,
  WeeklyReportListResponse,
  WeeklyReportDetailResponse,
  WeeklyReportGenerateResponse,
} from "@team-knowledge/shared";
import { redirectToSsoLogin, ssoLogoutApiUrl } from "./sso";
export type { ConversationListItem, ConversationListResponse } from "@team-knowledge/shared";

// The three soft-deletable entity kinds the recycle bin tracks.
export type RecycleBinKind = "article" | "folder" | "meeting";

// Soft edit-lock state carried on the article returned by GET /api/articles/:id.
// Non-null ONLY while a lock is ACTIVE (fresh heartbeat within the 45s TTL); the
// detail page uses it to disable the 编辑 button when someone else holds the lock.
export interface ArticleEditingState {
  userId: string;
  userName: string | null;
}

// `articles.get` augments the shared ArticleWithRelations with the live
// `editing` lock state (the shared type predates the lock feature, and the
// shared package isn't owned by the web app — so we widen it here). `editing`
// is optional because the PATCH/mutation responses don't carry it — only the
// GET detail endpoint populates it; consumers null/undefined-check before use.
// 管理后台「文档 AI 入库前置校验」运行参数。
export interface ArticleReviewSettings {
  enabled: boolean;
  scanIntervalSec: number;
  idleMinutes: number;
  // 严重度阈值:低于此级别的问题不点亮徽标(med=过滤 low;high=仅最严重;low=全部)。
  minSeverity: "low" | "med" | "high";
  // 每日复检提醒:仍有未优化问题的文档,按工作日+时间飞书提醒最后编辑者(直到修复/忽略)。
  reminderEnabled: boolean;
  reminderHour: number;      // 0-23(北京时间)
  reminderMinute: number;    // 0-59
  reminderWeekdays: number[]; // 1=周一..7=周日
}

// 管理后台 article-review 统一管理:有问题文档行 / 已忽略项行。
export interface ReviewIssueRow {
  id: string;
  title: string;
  roleName: string | null;
  findings: ReviewFinding[];
  reviewedAt: string | null;
  updatedAt: string;
}
export interface ReviewDismissedRow {
  articleId: string;
  articleTitle: string;
  hash: string;
  category: string;
  problem: string;
  dismissedAt: number;
  dismissedBy: string;
}

export type ArticleWithEditing = ArticleWithRelations & {
  editing?: ArticleEditingState | null;
  // AI 入库前置校验状态;reviewFindings 仅对有编辑权限者返回(见后端详情接口)。
  reviewStatus?: ReviewStatus;
  reviewFindings?: ReviewFinding[] | null;
};

// Shape returned by POST /api/articles/:id/edit-lock (acquire / refresh).
export interface EditLock {
  userId: string;
  userName: string | null;
  mine: boolean;
  ttlMs: number;
}

// BASE_URL is set by vite ('/' by default, or a sub-path such as '/kb/').
// Derive the API prefix from it so a sub-path deployment hits <prefix>/api/*.
// Exported for the SSE chat stream + meeting WS.
export const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") + "/api";
const BASE = API_BASE;

/** 服务端存储/返回的图片地址是根绝对的 `/uploads/<file>`,但应用挂在
 *  BASE_URL 前缀下(部署在子路径时),反向代理只映射 `<前缀>/uploads/` →
 *  API 的 `/uploads/`。渲染 <img>/<a> 前用它补前缀,否则 404(图裂)。 */
const UPLOAD_PREFIX = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
export function uploadSrc(url: string): string {
  return url.startsWith("/uploads/") ? UPLOAD_PREFIX + url : url;
}

/** 文章 markdown 的「存储形态 ↔ 显示形态」转换。存储里永远是裸的
 *  `/uploads/<file>`(导出 .md、跨环境部署都不携带前缀);进编辑器
 *  (含只读阅读视图)前补 BASE_URL 前缀让 <img>/附件链接能加载,
 *  序列化回存储时剥掉。覆盖 markdown 链接 `](/uploads/…)` 与内联
 *  HTML 的 `src="/uploads/…"` 两种写法。PREFIX 为空时是恒等变换。 */
export function uploadsToDisplay(md: string): string {
  // includes 短路:uploadsToStorage 在 markdownUpdated 里每次按键都跑,
  // 无图文档没必要做两遍全文 replaceAll。
  if (!UPLOAD_PREFIX || !md.includes("/uploads/")) return md;
  return md
    .replaceAll("(/uploads/", `(${UPLOAD_PREFIX}/uploads/`)
    .replaceAll('"/uploads/', `"${UPLOAD_PREFIX}/uploads/`);
}
export function uploadsToStorage(md: string): string {
  if (!UPLOAD_PREFIX || !md.includes("/uploads/")) return md;
  return md
    .replaceAll(`(${UPLOAD_PREFIX}/uploads/`, "(/uploads/")
    .replaceAll(`"${UPLOAD_PREFIX}/uploads/`, '"/uploads/');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  // Only set Content-Type when there is an actual body to send.
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers,
      ...init,
    });
  } catch {
    // Browsers throw TypeError on network failure (server down, DNS
    // failure, CORS preflight rejected, etc) — message text varies
    // ("Failed to fetch" / "Load failed" / "NetworkError when..."),
    // so we surface a single friendly Chinese message and tag it with
    // status 0 so callers can render a dedicated offline state
    // (retry button, etc) instead of showing the raw engine error.
    throw new ApiError(tr("error.network"), 0);
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try { body = await res.json() as { error?: string; message?: string }; } catch {}
    if (res.status === 401) {
      // SSO owns login. Clear local user state, then bounce to the SSO
      // landing with a return_to so the user lands back where they were.
      try { (await import("../stores/auth")).useAuth.getState().setUser(null); } catch { /* circular import safety */ }
      redirectToSsoLogin();
      throw new ApiError(body?.message ?? "请先登录", 401);
    }
    // 后端错误响应体多为 { error }(少数 { message });两者都读,否则回退通用文案。
    const detail =
      body && typeof body === "object"
        ? (typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : null)
        : null;
    const message = detail ?? `请求失败 (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// Thrown by acquireEditLock on a 409 (someone else holds an ACTIVE lock) so the
// caller can read who holds it without re-parsing the response body. Subclass of
// ApiError so existing `instanceof ApiError` checks still match.
export class EditLockConflictError extends ApiError {
  constructor(
    message: string,
    public lock: { userId: string; userName: string | null; mine: boolean },
  ) {
    super(message, 409);
  }
}

// In-app notification item (mirrors team-knowledge-api's NotificationItem).
export interface NotificationItem {
  id: string;
  type: string;
  articleId: string | null;
  commentId: string | null;
  readAt: string | null;
  createdAt: string;
  actorName: string;
  articleTitle: string;
  excerpt: string | null;
  actorAvatarUrl: string | null;
  // Web 通知类(automation_run / meeting_minutes / image_gen):自带标题/正文/站内跳转链接。
  title: string | null;
  body: string | null;
  link: string | null;
}

export interface NotificationPrefs {
  muteLikes: boolean;
  muteFavorites: boolean;
  muteComments: boolean;
  feishuEnabled: boolean;
  // Web(浏览器桌面)通知偏好:三类事件完成的接收开关 + 桌面弹窗总开关。
  muteAutomation: boolean;
  muteMeeting: boolean;
  muteImage: boolean;
  webEnabled: boolean;
}

// Web(浏览器桌面)通知的管理后台全局开关。
export interface WebNotifySettings {
  enabled: boolean;
  automation: boolean;
  meeting: boolean;
  image: boolean;
}

export type RoleSkillStatus = "empty" | "stale" | "generating" | "fresh" | "failed";
export interface RoleSkillData {
  status: RoleSkillStatus;
  content: string;
  name: string;
  description: string;
  generatedAt: string | null;
  stale: boolean;
  docCount: number;
  /** Live count of the role's currently-published docs (0 = only folders/drafts/empty). */
  currentDocCount: number;
  truncated: number;
  error: string | null;
}

// ── 专家(多-agent)──────────────────────────────
export interface ExpertSummary { roleId: string; name: string; color: string | null; instruction: string; avatarUrl: string | null; webSearch: boolean; canEdit: boolean }
export interface ExpertSources { kbDocs: boolean; crossModule: boolean; webSearch: boolean; consult: boolean }
export interface ExpertConfig { roleId: string; instruction: string; ownerUserId: string | null; avatarUrl: string | null; sources: ExpertSources; enabled: boolean }
export interface ExpertCitation { source: "doc" | "meeting" | "group-qa" | "web"; title: string; ref: string }
export interface ExpertTraceEvent { type: "routed" | "answered" | "summarized" | "consult" | "escalation" | "image" | "websearch"; roleIds?: string[]; roleId?: string; note?: string }
// 升级决策卡详情(含 roleId 供「转交」选人)。
export interface EscalationDetail { id: string; roleId: string; background: string; question: string; options: string[] }
export interface ExpertChatResult { answer: string; trace: ExpertTraceEvent[]; citations: ExpertCitation[]; images?: string[]; conversationId: string; escalationId?: string; escalation?: EscalationDetail;
  /** 生图场景:生成图前的「讲思路」叙述,归入「思考过程」折叠区(正文 answer 留空,只展示图)。 */
  thinking?: string }
export interface EscalationItem { id: string; roleId: string; background: string; question: string; options: string[]; createdAt: string; canForward?: boolean }
export interface RoleMember { userId: string; displayName: string; avatarUrl: string | null }

// ── 自动化(定时 AI 任务)──
export type AutomationScheduleKind = "cron" | "interval" | "once";
export interface AutomationScheduleConfig { weekdays?: number[]; hour?: number; minute?: number; everyMs?: number; atMs?: number }
export interface Automation {
  id: string; name: string; prompt: string; webhookUrl: string | null;
  scheduleKind: AutomationScheduleKind; scheduleConfig: AutomationScheduleConfig; scheduleLabel: string;
  effectiveFrom: string | null; effectiveTo: string | null;
  enabled: boolean; nextRunAt: string | null; runCount: number; lastRunStatus: string | null; pinnedAt: string | null; createdAt: string;
}
export interface AutomationRun {
  id: string; automationId: string; automationName: string;
  startedAt: string; finishedAt: string | null;
  status: string; isTest: boolean; outputPreview: string | null;
  delivery: { webhook?: string; httpStatus?: number | null; ok?: boolean; error?: string | null } | null; error: string | null;
}
// 单条运行详情(只读阅读页):完整产出 + 已转好的可读 markdown。
export interface AutomationRunDetail extends AutomationRun { prompt: string; output: string | null; displayText: string }
export interface AutomationTemplate {
  key: string; icon: string; title: string; description: string;
  prompt: string; scheduleKind: AutomationScheduleKind; scheduleConfig: AutomationScheduleConfig;
}
export interface AutomationListResponse { automations: Automation[]; recentRuns: AutomationRun[]; templates: AutomationTemplate[]; runsHasMore: boolean }
export interface AutomationRunsPage { runs: AutomationRun[]; hasMore: boolean }
export interface AutomationInput {
  name: string; prompt: string; webhookUrl?: string | null;
  scheduleKind: AutomationScheduleKind; scheduleConfig: AutomationScheduleConfig;
  effectiveFrom?: number | null; effectiveTo?: number | null;
}

export const api = {
  me: () => request<MeResponse>("/me"),
  // SSO owns the session; hit the SSO logout endpoint directly (not the
  // team-knowledge API, which no longer has a /logout route). Best-effort —
  // the store clears local state and redirects regardless.
  logout: async (): Promise<void> => {
    await fetch(ssoLogoutApiUrl(), { method: "POST", credentials: "include" }).catch(() => {});
  },
  updateProfile: (body: ProfileUpdateRequest) =>
    request<{ user: User }>("/me/profile", { method: "PATCH", body: JSON.stringify(body) }),
  myArticles: () => request<MyArticlesResponse>("/me/articles"),
  // 当前用户能否进管理后台 + 已对所有成员放开的页面 key。
  adminAccess: () => request<{ isAdmin: boolean; openPages: string[] }>("/me/admin-access"),
  myActivity: (opts: { page?: number; days?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.page) qs.set("page", String(opts.page));
    if (opts.days) qs.set("days", String(opts.days));
    const s = qs.toString();
    return request<AdminActivityPageResponse>(`/me/activity${s ? `?${s}` : ""}`);
  },
  myLikes: () => request<MyLikesResponse>("/me/likes"),
  // Articles I've been granted edit access to via the per-article ACL
  // (NOT articles I authored — those go through `myArticles`). Used
  // by the "我能编辑的" tab on the profile page.
  myCollaborations: () => request<CollaborationsResponse>("/me/collaborations"),
  // User search for the "add collaborator" autocomplete. Returns up
  // to 20 active users matching `q` against username or displayName.
  // Excludes self.
  searchUsers: (q: string, includeSelf = false) =>
    request<UserSearchResponse>(`/users/search?q=${encodeURIComponent(q)}${includeSelf ? "&includeSelf=1" : ""}`),
  // Cross-folder time-flow. Empty filter = every visible article;
  // `roleId` narrows to articles whose folder belongs to that role;
  // `folderId` narrows further to a single folder. take ≤ 200.
  feed: (filter: { roleId?: string; folderId?: string; take?: number } = {}) => {
    const q = new URLSearchParams();
    if (filter.roleId) q.set("roleId", filter.roleId);
    if (filter.folderId) q.set("folderId", filter.folderId);
    if (filter.take) q.set("take", String(filter.take));
    const qs = q.toString();
    return request<FeedResponse>(`/me/feed${qs ? `?${qs}` : ""}`);
  },

  // Public per-user profile — viewable by any logged-in user. `profile`
  // is identity-only (no email); `articles` / `activity` are ACL-filtered
  // to the VIEWER server-side (see routes/users.ts).
  users: {
    profile: (id: string) => request<PublicUserProfileResponse>(`/users/${id}`),
    articles: (id: string) => request<FeedResponse>(`/users/${id}/articles`),
    activity: (id: string, page = 1) =>
      request<AdminActivityPageResponse>(`/users/${id}/activity?page=${page}`),
  },

  automations: {
    list: () => request<AutomationListResponse>("/automations"),
    get: (id: string) => request<Automation>(`/automations/${id}`),
    getRun: (runId: string) => request<AutomationRunDetail>(`/automations/runs/${runId}`),
    runs: (cursor?: string, limit = 10) =>
      request<AutomationRunsPage>(`/automations/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    // 单个任务的运行记录分页(「已完成」每个任务折叠展开/加载更多)。
    taskRuns: (id: string, cursor?: string, limit = 5) =>
      request<AutomationRunsPage>(`/automations/${id}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    create: (input: AutomationInput) => request<Automation>("/automations", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, input: AutomationInput) => request<Automation>(`/automations/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    remove: (id: string) => request<{ ok: true }>(`/automations/${id}`, { method: "DELETE" }),
    pause: (id: string) => request<Automation>(`/automations/${id}/pause`, { method: "POST" }),
    resume: (id: string) => request<Automation>(`/automations/${id}/resume`, { method: "POST" }),
    pin: (id: string, pinned: boolean) => request<Automation>(`/automations/${id}/pin`, { method: "POST", body: JSON.stringify({ pinned }) }),
    run: (id: string) => request<{ started: boolean; alreadyRunning?: boolean }>(`/automations/${id}/run`, { method: "POST" }),
  },
  workspace: {
    listRoles: () => request<WorkspaceRoleListResponse>("/workspace/roles"),
    // 角色个人置顶(每人各自;置顶的浮到边栏最顶)。
    pinRole: (roleId: string, pinned: boolean) =>
      request<{ ok: true }>(`/workspace/roles/${roleId}/pin`, { method: "PATCH", body: JSON.stringify({ pinned }) }),
    listFolders: (roleId: string) =>
      request<WorkspaceFolderListResponse>(`/workspace/roles/${roleId}/folders`),
    getFolder: (id: string) =>
      request<WorkspaceFolderResponse>(`/workspace/folders/${id}`),
    // Sidebar tree: folders + role-direct docs under a role.
    // Permission-filtered server-side.
    tree: (roleId: string) =>
      request<WorkspaceTreeResponse>(`/workspace/roles/${roleId}/tree`),
  },

  folders: {
    create: (body: FolderCreateRequest) =>
      request<FolderMutationResponse>("/folders", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: FolderUpdateRequest) =>
      request<FolderMutationResponse>(`/folders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    // onContent decides what happens to docs inside:
    //   "move" (default) → docs drop to role-direct under same role
    //   "cascade"        → docs are deleted along with the folder
    delete: (id: string, onContent: FolderDeleteOnContent = "move") =>
      request<void>(`/folders/${id}?onContent=${onContent}`, { method: "DELETE" }),
    // Drag-reorder folders within a role; ids are the new order.
    reorder: (body: FolderReorderRequest) =>
      request<{ ok: true }>("/folders/reorder", { method: "POST", body: JSON.stringify(body) }),
  },

  articles: {
    list: (folderId: string) =>
      request<ArticleListResponse>(`/folders/${folderId}/articles`),
    // The detail response carries the live `editing` lock state on top of the
    // shared ArticleWithRelations shape (see ArticleWithEditing).
    get: (id: string) =>
      request<{ article: ArticleWithEditing }>(`/articles/${id}`),
    create: (body: ArticleCreateRequest) =>
      request<ArticleMutationResponse>("/articles", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: ArticleUpdateRequest) =>
      request<ArticleMutationResponse>(`/articles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    // Best-effort save for the page-unload path. A normal autosave fetch is
    // aborted when the page goes away (tab close / reload); `keepalive` lets the
    // PATCH outlive the page so edits in the autosave debounce window aren't
    // lost. Fire-and-forget — at unload there's nothing to await or recover.
    updateBeacon: (id: string, body: ArticleUpdateRequest) => {
      try {
        void fetch(`${API_BASE}/articles/${id}`, {
          method: "PATCH",
          credentials: "include",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch { /* unload path — unrecoverable */ }
    },
    delete: (id: string) =>
      request<void>(`/articles/${id}`, { method: "DELETE" }),
    bulk: (body: ArticleBulkRequest) =>
      request<ArticleBulkResponse>("/articles/bulk", { method: "POST", body: JSON.stringify(body) }),
    // Move a doc to a different parent (folder ↔ role-direct).
    // targetFolderId = null means role-direct.
    move: (id: string, targetFolderId: string | null) =>
      request<ArticleMoveResponse>(`/articles/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ targetFolderId }),
      }),
    // Drag-reorder docs within a sibling group.
    reorder: (body: ArticleReorderRequest) =>
      request<{ ok: true }>("/articles/reorder", { method: "POST", body: JSON.stringify(body) }),
    // AI 入库前置校验:一键优化 / 应用修订 / 忽略问题。
    review: {
      // 一键优化改走 SSE(大文档耗时长,同步返回会被网关 idle 超时切断报 504)。这里薄封装
      // streamOptimize;onProgress 供 UI 显示「已生成 N 字」。动态 import 避免与 api.ts 的循环依赖。
      optimize: async (
        id: string,
        opts?: { signal?: AbortSignal; onProgress?: (charsSoFar: number) => void },
      ): Promise<{ fixedMarkdown: string; unlocated: number }> => {
        const { streamOptimize } = await import("@/components/article/streamOptimize");
        return streamOptimize(id, opts);
      },
      apply: (id: string, contentMarkdown: string, expectedUpdatedAt?: string) =>
        request<{ reviewStatus: ReviewStatus; reviewFindings: ReviewFinding[] | null; updatedAt: string | null }>(
          `/articles/${id}/review/apply`, { method: "POST", body: JSON.stringify({ contentMarkdown, expectedUpdatedAt }) },
        ),
      dismiss: (id: string) =>
        request<{ ok: true }>(`/articles/${id}/review/dismiss`, { method: "POST" }),
    },
    // Import a .md file as a doc. Title is editable in the dialog before this
    // call; sent as a form field alongside the file.
    //
    // onConflict 决定同名(同一目录/角色位置)时的行为:
    //   省略     → 后端返回 409,这里以 { conflict } 形式回传(不抛错),弹窗让用户选;
    //   overwrite → 覆盖同名文档(原内容存历史),返回该文档 id;
    //   rename    → 自动改名「标题 (n)」后新建。
    // 返回判别联合:{ article } 成功 / { conflict } 命中重名待用户选择。
    importMd: async (params: {
      roleId: string;
      folderId: string | null;
      title: string;
      file: File;
      onConflict?: "overwrite" | "rename";
    }): Promise<
      | { article: { id: string }; overwritten?: boolean }
      | { conflict: { existingId: string; title: string } }
    > => {
      // 字段必须全部排在 file 之前:后端用 fastify 的 file.fields 读取,流式解析
      // 下它只含「文件之前」出现的字段;放在 file 之后的字段后端读不到(曾导致
      // onConflict 丢失,覆盖/改名失效)。file 最后 append。
      const fd = new FormData();
      fd.append("roleId", params.roleId);
      fd.append("folderId", params.folderId ?? "null");
      fd.append("title", params.title);
      if (params.onConflict) fd.append("onConflict", params.onConflict);
      fd.append("file", params.file);
      const res = await fetch(`${API_BASE}/articles/import`, { method: "POST", body: fd, credentials: "include" });
      if (res.status === 409) {
        const body = await res.json().catch(() => null);
        if (body?.error === "duplicate_title" && body?.existing?.id) {
          return { conflict: { existingId: body.existing.id, title: body.existing.title } };
        }
        throw new ApiError(body?.message ?? "导入失败 (409)", 409);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(body?.message ?? `导入失败 (${res.status})`, res.status);
      }
      const data = (await res.json()) as { article: { id: string }; overwritten?: boolean };
      return { article: data.article, overwritten: data.overwritten };
    },
    // Import a Feishu docx/wiki document as a new article. `unsupportedMode`
    // controls whether blocks Markdown can't represent become a WYSIWYG-friendly
    // placeholder note ("placeholder") or are dropped ("drop"). Returns the new
    // doc id + a conversion report (counts + warnings) for the success toast.
    importFeishu: async (params: {
      roleId: string;
      folderId: string | null;
      url: string;
      unsupportedMode: "placeholder" | "drop";
    }) => {
      const res = await fetch(`${API_BASE}/articles/import-feishu`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new ApiError(body?.message ?? `导入失败 (${res.status})`, res.status);
      }
      return res.json() as Promise<{
        article: { id: string };
        report: { converted: number; droppedBlocks: number; placeholderBlocks: number; warnings: string[] };
      }>;
    },
    versions: (id: string) =>
      request<ArticleVersionListResponse>(`/articles/${id}/versions`),
    // Revert the article's title + body to a historical version. Same
    // permission as editing; archived docs reject (the doc must be
    // un-archived first). Returns the updated article (same shape as
    // update()). The pre-restore state is snapshotted into history.
    restoreVersion: (id: string, versionId: string) =>
      request<ArticleMutationResponse>(`/articles/${id}/versions/${versionId}/restore`, {
        method: "POST",
      }),
    // PV / 独立访客 / 谁看过 for the doc-detail dialog. `viewers` is null
    // unless the caller is the author / admin / collaborator.
    views: (id: string) =>
      request<ArticleViewsResponse>(`/articles/${id}/views`),
    // Soft edit-lock. acquireEditLock both ACQUIRES (on mount) and REFRESHES
    // (heartbeat) the lock — the server treats POST as upsert. On a 409 (an
    // ACTIVE lock held by someone else) it throws EditLockConflictError
    // carrying the holder so the caller can show who's editing; other non-2xx
    // (403/404) surface as the usual ApiError via `request`.
    acquireEditLock: async (id: string): Promise<{ lock: EditLock }> => {
      const res = await fetch(`${API_BASE}/articles/${id}/edit-lock`, {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => null) as
          | { message?: string; lock?: { userId: string; userName: string | null; mine: boolean } }
          | null;
        throw new EditLockConflictError(
          body?.message ?? "文档正在被他人编辑",
          body?.lock ?? { userId: "", userName: null, mine: false },
        );
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string } | null;
        throw new ApiError(body?.message ?? `获取编辑锁失败 (${res.status})`, res.status);
      }
      return res.json() as Promise<{ lock: EditLock }>;
    },
    releaseEditLock: (id: string): Promise<void> =>
      request<void>(`/articles/${id}/edit-lock`, { method: "DELETE" }),
    search: (q: string) =>
      request<ArticleSearchResponse>(`/articles/search?q=${encodeURIComponent(q)}`),
    // 顶栏搜索弹窗空态的「最近浏览」—— 当前用户最近打开过、仍可查看的文档。
    recentViews: (take?: number) =>
      request<ArticleRecentViewsResponse>(`/articles/recent-views${take ? `?take=${take}` : ""}`),
    exportUrl: (id: string) => `${API_BASE}/articles/${id}/export`,
    // Per-article editor ACL. Author + admin only — the API
    // returns 403 for everyone else. Use these to manage the
    // collaborator list shown on the profile page's "我的文章" row.
    editors: {
      list: (articleId: string) =>
        request<ArticleEditorListResponse>(`/articles/${articleId}/editors`),
      add: (articleId: string, userId: string) =>
        request<ArticleEditorAddResponse>(`/articles/${articleId}/editors`, {
          method: "POST",
          body: JSON.stringify({ userId }),
        }),
      remove: (articleId: string, userId: string) =>
        request<void>(`/articles/${articleId}/editors/${userId}`, { method: "DELETE" }),
    },
  },

  bookmarks: {
    list: () => request<BookmarkListResponse>("/bookmarks"),
    // Both add/remove now return `{ isBookmarked, bookmarkCount }` so
    // the action-bar badge can update without a follow-up GET. Add
    // also still carries the freshly-created `bookmark` row for any
    // callers that need it (currently none in the app, but keeping it
    // preserves the legacy contract).
    add: (articleId: string) =>
      request<{ bookmark: Bookmark; isBookmarked: boolean; bookmarkCount: number }>(
        "/bookmarks",
        { method: "POST", body: JSON.stringify({ articleId }) },
      ),
    remove: (articleId: string) =>
      request<{ isBookmarked: boolean; bookmarkCount: number }>(
        `/bookmarks/${articleId}`,
        { method: "DELETE" },
      ),
  },

  likes: {
    add: (articleId: string) =>
      request<{ isLiked: boolean; likeCount: number }>(`/articles/${articleId}/like`, { method: "POST" }),
    remove: (articleId: string) =>
      request<{ isLiked: boolean; likeCount: number }>(`/articles/${articleId}/like`, { method: "DELETE" }),
  },

  comments: {
    list: (articleId: string) =>
      request<{ comments: CommentRow[]; nextCursor: string | null }>(
        `/articles/${articleId}/comments`,
      ),
    add: (articleId: string, body: string, parentId: string | null = null) =>
      request<{ comment: CommentRow }>(`/articles/${articleId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body, parentId }),
      }),
    remove: (commentId: string) =>
      request<{ ok: true }>(`/comments/${commentId}`, { method: "DELETE" }),
    like: (commentId: string) =>
      request<{ isLiked: boolean; likeCount: number }>(`/comments/${commentId}/like`, { method: "POST" }),
    unlike: (commentId: string) =>
      request<{ isLiked: boolean; likeCount: number }>(`/comments/${commentId}/like`, { method: "DELETE" }),
  },

  notifications: {
    list: (cursor?: string) =>
      request<{ notifications: NotificationItem[]; nextCursor: string | null }>(
        `/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    unreadCount: () => request<{ count: number }>("/notifications/unread-count"),
    /** 打开文章时把与它相关的未读通知全部标记已读(自动清红点)。 */
    readByArticle: (articleId: string) =>
      request<{ ok: true; unread: number }>("/notifications/read", {
        method: "POST",
        body: JSON.stringify({ articleId }),
      }),
    // No ids → mark ALL read. Returns the fresh unread count for the badge.
    markRead: (ids?: string[]) =>
      request<{ ok: true; unread: number }>("/notifications/read", {
        method: "POST",
        body: JSON.stringify(ids && ids.length ? { ids } : {}),
      }),
    getPrefs: () => request<NotificationPrefs>("/notifications/prefs"),
    setPrefs: (patch: Partial<NotificationPrefs>) =>
      request<NotificationPrefs>("/notifications/prefs", { method: "PUT", body: JSON.stringify(patch) }),
  },

  // Per-role AI skill.md (read-only: copy / download). Generation + refresh
  // happen server-side; the client only reads, triggers a regenerate, and
  // links to the raw download.
  roleSkill: {
    get: (roleId: string) => request<RoleSkillData>(`/roles/${roleId}/skill`),
    // Per-role skill availability for the chat @ Skills picker.
    summary: () => request<RoleSkillSummaryResponse>("/roles/skill-summary"),
    regenerate: (roleId: string) =>
      request<{ ok: true; status: string; upToDate?: boolean }>(`/roles/${roleId}/skill/regenerate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    rawUrl: (roleId: string, opts: { download?: boolean } = {}) =>
      `${API_BASE}/roles/${roleId}/skill/raw${opts.download ? "?download=1" : ""}`,
  },

  uploads: {
    image: async (file: File): Promise<ImageUploadResponse> => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/uploads/image`, { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(body?.message ?? `上传失败 (${res.status})`, res.status);
      }
      return res.json() as Promise<ImageUploadResponse>;
    },
    file: async (file: File): Promise<FileUploadResponse> => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/uploads/file`, { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(body?.message ?? `上传失败 (${res.status})`, res.status);
      }
      return res.json() as Promise<FileUploadResponse>;
    },
  },

  admin: {
    dashboard: (days?: number) =>
      request<AdminDashboardResponse>(`/admin/dashboard${days ? `?days=${days}` : ""}`),
    analytics: (days?: number) =>
      request<AdminAnalyticsResponse>(`/admin/analytics${days ? `?days=${days}` : ""}`),
    // SSE stream — consumed by useDashboardStream (raw fetch, not request<T>).
    dashboardStreamUrl: () => `${API_BASE}/admin/dashboard/stream`,
    activity: (opts: { userId?: string; page?: number; days?: number } = {}) => {
      const qs = new URLSearchParams();
      if (opts.userId) qs.set("userId", opts.userId);
      if (opts.page) qs.set("page", String(opts.page));
      if (opts.days) qs.set("days", String(opts.days));
      const s = qs.toString();
      return request<AdminActivityPageResponse>(`/admin/activity${s ? `?${s}` : ""}`);
    },
    listUsers: () => request<AdminUserListResponse>("/admin/users"),
    updateUser: (id: string, body: AdminUserUpdateRequest) =>
      request<AdminUserUpdateResponse>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteUser: (id: string) =>
      request<void>(`/admin/users/${id}`, { method: "DELETE" }),

    listRoles: () => request<RoleListResponse>("/admin/roles"),
    createRole: (body: RoleCreateRequest) =>
      request<RoleMutationResponse>("/admin/roles", { method: "POST", body: JSON.stringify(body) }),
    updateRole: (id: string, body: RoleUpdateRequest) =>
      request<RoleMutationResponse>(`/admin/roles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteRole: (id: string) =>
      request<void>(`/admin/roles/${id}`, { method: "DELETE" }),

    //助手内容过滤:管理员维护的排除清单(角色 / 文件夹 / 文档)。被排除的目标
    // 不进入助手的检索与分析(问答 / 会议 / 群聊答疑 / 文档体检)。
    assistantFilter: {
      get: () => request<{
        roles: { id: string; name: string }[];
        folders: { id: string; name: string; roleId: string; parentId: string | null }[];
        articles: { id: string; title: string; roleId: string; folderId: string | null }[];
      }>("/admin/assistant-filter"),
      add: (targetType: "role" | "folder" | "article", targetId: string) =>
        request<{ ok: true }>("/admin/assistant-filter", { method: "POST", body: JSON.stringify({ targetType, targetId }) }),
      remove: (targetType: "role" | "folder" | "article", targetId: string) =>
        request<{ ok: true }>("/admin/assistant-filter", { method: "DELETE", body: JSON.stringify({ targetType, targetId }) }),
    },

    // DB 备份 / 还原(仅管理员)。restore 为进程内热替换,成功后前端应自刷新。
    backup: {
      list: () => request<BackupListResponse>("/admin/backup"),
      create: () => request<BackupCreateResponse>("/admin/backup", { method: "POST", body: "{}" }),
      restore: (name: string) =>
        request<BackupRestoreResponse>(`/admin/backup/${encodeURIComponent(name)}/restore`, {
          method: "POST",
          body: "{}",
        }),
      remove: (name: string) =>
        request<void>(`/admin/backup/${encodeURIComponent(name)}`, { method: "DELETE" }),
    },

    // 知识库周报(仅管理员)。
    weeklyReport: {
      list: () => request<WeeklyReportListResponse>("/admin/weekly-report"),
      get: (id: string) => request<WeeklyReportDetailResponse>(`/admin/weekly-report/${id}`),
      generate: () =>
        request<WeeklyReportGenerateResponse>("/admin/weekly-report/generate", { method: "POST", body: "{}" }),
    },

    // GitHub 仓库配置(仅管理员)— 供周五周报「研发改动」统计。token 不回传。
    github: {
      list: () => request<{ repos: GithubRepoView[] }>("/admin/github/repos"),
      add: (body: { owner: string; repo: string; label?: string; auth?: "token" | "ssh"; token?: string }) =>
        request<{ repo: GithubRepoView }>("/admin/github/repos", { method: "POST", body: JSON.stringify(body) }),
      remove: (id: string) => request<void>(`/admin/github/repos/${encodeURIComponent(id)}`, { method: "DELETE" }),
      // 临时测试(新增表单提交前):现填 owner/repo/auth/token 即测。
      test: (body: { owner: string; repo: string; auth?: "token" | "ssh"; token?: string }) =>
        request<GithubTestResult>("/admin/github/test", { method: "POST", body: JSON.stringify(body) }),
      // 测试已存仓库:用服务端存储的 token,无需重新输入。
      testSaved: (id: string) =>
        request<GithubTestResult>(`/admin/github/repos/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" }),
      // 列出该仓库远端全部分支(选分支面板);selected = 当前已选(空 = 全部)。
      branches: (id: string) =>
        request<{ branches: string[]; selected: string[] }>(`/admin/github/repos/${encodeURIComponent(id)}/branches`),
      // 保存周报统计分支;空数组 = 恢复全部分支。
      updateBranches: (id: string, branches: string[]) =>
        request<{ repo: GithubRepoView }>(`/admin/github/repos/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ branches }),
        }),
    },

    // 飞书群任务控制台(仅管理员)— 配置各通知任务的目标群/自动任务开关,或手动发送测试。
    // send 为异步任务:POST 返回 202 + jobId(组卡片可能跑 LLM 数分钟),sendStatus 轮询结果。
    notifyTest: {
      list: () => request<{ scenarios: NotifyTestScenario[] }>("/admin/notify-test/scenarios"),
      update: (key: string, body: { enabled?: boolean; chatIds?: string[]; schedule?: NotifyTestCronSchedule }) =>
        request<{ scenario: NotifyTestScenario }>(`/admin/notify-test/scenarios/${encodeURIComponent(key)}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      send: (key: string) =>
        request<{ jobId: string }>("/admin/notify-test/send", {
          method: "POST",
          body: JSON.stringify({ key }),
        }),
      sendStatus: (jobId: string) =>
        request<{ status: "running" | "done"; ok?: boolean; results?: NotifyTestSendResult[]; error?: string }>(
          `/admin/notify-test/send/${encodeURIComponent(jobId)}`,
        ),
    },
    // 群聊智能答疑:命中记录看板(只读)+ 互动节奏参数(仅管理员可改)。
    groupQa: {
      stats: () => request<{ entries: GroupQaStatEntry[] }>("/admin/group-qa/stats"),
      tuning: {
        get: () => request<GroupQaTuning>("/admin/group-qa/tuning"),
        set: (body: Partial<GroupQaTuning>) =>
          request<GroupQaTuning>("/admin/group-qa/tuning", { method: "PUT", body: JSON.stringify(body) }),
      },
      like: {
        get: () => request<GroupQaLike>("/admin/group-qa/like"),
        set: (body: Partial<GroupQaLike>) =>
          request<GroupQaLike>("/admin/group-qa/like", { method: "PUT", body: JSON.stringify(body) }),
      },
      likes: () => request<{ entries: GroupQaLikeEntry[] }>("/admin/group-qa/likes"),
    },
  },

  chat: {
    getConversation: (conversationId: string, opts?: { before?: string; limit?: number }) => {
      const qs = new URLSearchParams({ conversationId });
      if (opts?.before) qs.set("before", opts.before);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      return request<ConversationResponse>(`/chat/conversation?${qs.toString()}`);
    },
    listConversations: (opts?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.offset != null) qs.set("offset", String(opts.offset));
      const s = qs.toString();
      return request<ConversationListResponse>(`/chat/conversations${s ? `?${s}` : ""}`);
    },
    renameConversation: (id: string, title: string) =>
      request<{ ok: true }>(`/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
    pinConversation: (id: string, pinned: boolean) =>
      request<{ ok: true }>(`/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ pinned }) }),
    deleteConversation: (id: string) =>
      request<void>(`/chat/conversations/${id}`, { method: "DELETE" }),
    // Realtime nudge stream (SSE):server pushes "update" when a turn lands
    // off-page(飞书单聊 /助手通知)。Raw URL — see useChatUpdates.ts.
    streamUrl: () => `${API_BASE}/chat/stream`,
    clearConversation: (conversationId: string) =>
      request<void>(`/chat/conversation?conversationId=${encodeURIComponent(conversationId)}`, { method: "DELETE" }),
    // streamMessage is intentionally NOT a `request<T>` call — SSE consumers
    // need raw access to response.body. See useChatStream.ts.

    // Render selected chat messages into a PNG card. Bypasses request<T>
    // (which parses JSON) so we get the raw image Blob back. Errors come back
    // as JSON, so surface their message; otherwise return the blob to preview.
    shareImage: async (payload: { title?: string; messages: { role: "user" | "assistant"; content: string; images?: string[] }[] }): Promise<Blob> => {
      const res = await fetch(`${API_BASE}/chat/share-image`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => { throw new ApiError("无法连接到服务器，请检查网络或稍后重试", 0); });
      if (!res.ok) {
        let msg = "生成图片失败";
        try { const b = await res.json() as { message?: string }; if (b?.message) msg = b.message; } catch { /* non-JSON error */ }
        throw new ApiError(msg, res.status);
      }
      return res.blob();
    },
  },

  adminPageVisibility: {
    get: () => request<{ pages: { key: string; label: string; visibility: "admin" | "all" }[] }>("/admin/page-visibility"),
    set: (key: string, visibility: "admin" | "all") =>
      request<{ pages: { key: string; label: string; visibility: "admin" | "all" }[] }>(
        "/admin/page-visibility", { method: "PATCH", body: JSON.stringify({ key, visibility }) }),
  },

  adminArticleReview: {
    issues: () => request<{ items: ReviewIssueRow[] }>("/admin/article-review/issues"),
    dismissed: () => request<{ items: ReviewDismissedRow[] }>("/admin/article-review/dismissed"),
    undismiss: (articleId: string, hash: string) =>
      request<{ ok: true }>("/admin/article-review/undismiss", { method: "POST", body: JSON.stringify({ articleId, hash }) }),
  },

  adminSettings: {
    getLlmProvider: () => request<LlmProviderStatus>("/admin/settings/llm-provider"),
    setLlmProvider: (body: LlmProviderUpdateRequest) =>
      request<LlmProviderStatus>("/admin/settings/llm-provider", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    // CLI 可执行文件路径(claude/codex)。systemd 精简 PATH 找不到 nvm 里的
    // 命令时,管理员填绝对路径;保存返回最新探测结果。
    getLlmBinaries: () => request<LlmBinarySettings>("/admin/settings/llm-binaries"),
    setLlmBinaries: (body: LlmBinaryUpdateRequest) =>
      request<LlmBinarySettings>("/admin/settings/llm-binaries", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    // 各引擎使用的模型 ID;保存后对新发起的调用立即生效。
    getLlmModels: () => request<LlmModelSettings>("/admin/settings/llm-models"),
    setLlmModels: (body: LlmModelUpdateRequest) =>
      request<LlmModelSettings>("/admin/settings/llm-models", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    // 对外显示的模型型号(手填 curated 三段 + 群卡片开关);GET 附带探测到的真实模型。
    getModelDisplay: () => request<ModelDisplayAdmin>("/admin/settings/model-display"),
    setModelDisplay: (body: Partial<ModelDisplayConfig>) =>
      request<ModelDisplayAdmin>("/admin/settings/model-display", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    // 火山 STT 凭据。GET 对密钥字段(apiKey / accessToken)只返回掩码(****末4位)；
    // PUT 回传掩码 = 不修改，空串 = 清除。
    getVolcStt: () =>
      request<{
        configured: boolean;
        appId: string | null;
        accessToken: string | null;
        apiKey: string | null;
        endpoint: string | null;
        resourceId: string | null;
        model: string | null;
        boostingTableId: string | null;
      }>("/admin/settings/volc-stt"),
    saveVolcStt: (body: {
      apiKey?: string; appId?: string; accessToken?: string; endpoint?: string | null; resourceId?: string | null; model?: string | null; boostingTableId?: string | null;
    }) =>
      request<{ ok: true }>("/admin/settings/volc-stt", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    clearVolcStt: () =>
      request<{ ok: true }>("/admin/settings/volc-stt", { method: "DELETE" }),
    // 火山 TTS credentials.
    getVolcTts: () =>
      request<{
        configured: boolean;
        appId: string | null;
        accessToken: string | null;
        apiKey: string | null;
        voice: string | null;
        endpoint: string | null;
      }>("/admin/settings/volc-tts"),
    saveVolcTts: (body: {
      apiKey?: string; appId?: string; accessToken?: string; voice?: string | null; endpoint?: string | null;
    }) =>
      request<{ ok: true }>("/admin/settings/volc-tts", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    clearVolcTts: () =>
      request<{ ok: true }>("/admin/settings/volc-tts", { method: "DELETE" }),
    // 单篇 AI 入库前置校验总开关。
    articleReview: {
      get: () => request<ArticleReviewSettings>("/admin/settings/article-review"),
      set: (patch: Partial<ArticleReviewSettings>) =>
        request<ArticleReviewSettings>("/admin/settings/article-review", { method: "PATCH", body: JSON.stringify(patch) }),
    },
    // Web(浏览器桌面)通知全局开关。
    webNotify: {
      get: () => request<WebNotifySettings>("/admin/settings/web-notify"),
      set: (patch: Partial<WebNotifySettings>) =>
        request<WebNotifySettings>("/admin/settings/web-notify", { method: "PATCH", body: JSON.stringify(patch) }),
    },
    // 知识库「文档体检」检测参数:强度评级(1-10)+ 每类最多显示条数。
    docAuditTuning: {
      get: () => request<{ strength: number; maxPerCategory: number }>("/admin/settings/doc-audit-tuning"),
      set: (body: { strength?: number; maxPerCategory?: number }) =>
        request<{ strength: number; maxPerCategory: number }>("/admin/settings/doc-audit-tuning", { method: "PUT", body: JSON.stringify(body) }),
    },
  },

  //助手会议 — hub (list) + create (admin) + detail
  // + end. Live audio + transcription land in later phases over
  // WebSocket (separate module). The shape here is stable.
  meeting: {
    hub: () => request<MeetingHubResponse>("/meeting/hub"),
    // Cheap single-COUNT endpoint for the nav red dot. Avoid /hub
    // for that purpose — /hub has N+1 role / host lookups per row
    // and is overkill when we just need "is anything live?".
    hasActive: () => request<{ hasActive: boolean }>("/meeting/has-active"),
    get: (id: string) => request<MeetingDetailResponse>(`/meeting/${id}`),
    create: (body: MeetingCreateRequest) =>
      request<{ session: MeetingSessionRow }>("/meeting", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    /** Edit visibility/title (creator or admin), active or ended. */
    update: (id: string, body: MeetingUpdateRequest) =>
      request<{ session: MeetingSessionRow }>(`/meeting/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    end: (id: string) =>
      request<{ session: MeetingSessionRow }>(`/meeting/${id}`, { method: "DELETE" }),
    /** manually re-trigger summary generation when the auto
     *  fire-and-forget after DELETE failed (LLM outage etc). */
    regenerateSummary: (id: string) =>
      request<{ session: MeetingSessionRow }>(`/meeting/${id}/summary`, { method: "POST" }),
    // Soft-delete an ended meeting → it moves to the deleter's recycle
    // bin (restore / permanently delete there). Creator OR admin; the host
    // can also 结束 (status flip) separately. Path kept as /hard for
    // back-compat — the server now soft-deletes instead of purging.
    hardDelete: (id: string) =>
      request<void>(`/meeting/${id}/hard`, { method: "DELETE" }),
    /** persist the generated summary as a knowledge-base
     *  article. Admin-only at the server. Returns the new article id. */
    saveAsArticle: (id: string, body: { roleId: string; folderId?: string | null }) =>
      request<{ article: { id: string; title: string; status: string } }>(`/meeting/${id}/save-as-article`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  // Per-user recycle bin. Lists ONLY the caller's own soft-deleted
  // articles / folders / meetings; restore brings an item back, remove
  // permanently purges it. Server enforces deletedById === caller || admin.
  recycleBin: {
    list: () => request<RecycleBinListResponse>("/recycle-bin"),
    restore: (kind: RecycleBinKind, id: string) =>
      request<void>(`/recycle-bin/${kind}/${id}/restore`, { method: "POST" }),
    remove: (kind: RecycleBinKind, id: string) =>
      request<void>(`/recycle-bin/${kind}/${id}`, { method: "DELETE" }),
    /** 一键清空:永久删除本人回收站全部内容。 */
    clear: () =>
      request<{ purged: { articles: number; folders: number; meetings: number } }>(
        "/recycle-bin",
        { method: "DELETE" },
      ),
  },

  // ── 专家 ──
  // 注:/agents/chat 是 SSE 流式接口,不走 request();见 components/chat/streamUnifiedChat.ts。
  agents: {
    list: () => request<{ experts: ExpertSummary[] }>("/agents"),
    myEscalations: () => request<{ items: EscalationItem[] }>("/me/escalations"),
    resolveEscalation: (id: string, resolution: string) =>
      request<{ id: string; status: string; resolution: string }>(
        `/agents/escalations/${id}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) }),
    forwardEscalation: (id: string, toUserId: string) =>
      request<{ ok: boolean; cardSent: boolean }>(
        `/agents/escalations/${id}/forward`, { method: "POST", body: JSON.stringify({ toUserId }) }),
  },
  roles: {
    members: (roleId: string) => request<{ members: RoleMember[] }>(`/roles/${roleId}/members`),
  },
  // 按名搜任意启用用户。供「负责人/转交目标」选人;includeSelf=1 让自己也可被选中
  //(默认负责人常是本人;单成员场景下不至于搜不到)。q 需 ≥2 字符。
  usersSearch: (q: string) => request<{ users: { id: string; displayName: string; avatarUrl: string | null }[] }>(`/users/search?q=${encodeURIComponent(q)}&includeSelf=1`),
  adminExperts: {
    get: (roleId: string) => request<ExpertConfig>(`/admin/roles/${roleId}/expert`),
    set: (
      roleId: string,
      patch: Partial<{ instruction: string; ownerUserId: string | null; avatarUrl: string | null; enabled: boolean; sources: Partial<ExpertSources> }>,
    ) => request<ExpertConfig>(`/admin/roles/${roleId}/expert`, { method: "PATCH", body: JSON.stringify(patch) }),
  },
};

// GitHub 仓库配置(管理后台 → 周报研发改动)。token 永不回传,仅 hasToken 标记。
export interface GithubRepoView {
  id: string;
  owner: string;
  repo: string;
  label: string;
  auth: "token" | "ssh";
  hasToken: boolean;
  /** 周报统计的分支;空数组 = 全部分支。 */
  branches: string[];
}
export interface GithubTestResult {
  ok: boolean;
  fullName: string;
  detail: string; // 人读详情:token→「私有 · 默认分支 main」;ssh→「SSH · HEAD abc1234」
}

// 飞书群任务控制台(管理后台 → 系统管理 → 飞书群任务)。
export interface NotifyTestTarget {
  chatId: string;
  name: string; // 群名(配了 FEISHU_CHAT_NAMES 用群名,否则回退 chatId)
}
export interface NotifyTestScenario {
  key: string;
  title: string;
  description: string;
  triggerType: "cron" | "event"; // 自动任务类型:定时 / 事件触发
  schedule: string;              // 人读的触发时机,如「每周五 21:00(北京时间)」
  enabled: boolean;              // 自动任务开关(手动发送测试不受影响)
  available: NotifyTestTarget[]; // 可勾选的群
  selected: string[];            // 已勾选的群 chat_id(默认全选)
  running: boolean;              // 此刻是否正在执行(定时触发/发送测试)
  cronSchedule: NotifyTestCronSchedule | null; // 定时类任务的触发配置;event 类为 null
}
/** 定时触发配置(北京时间):weekdays 用 1=周一…7=周日;repeat=false 表示
 *  仅执行一次,触发后自动停用。 */
export interface NotifyTestCronSchedule {
  weekdays: number[];
  hour: number;
  minute: number;
  repeat: boolean;
}
export interface NotifyTestSendResult {
  chatId: string;
  name: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}
/** 群聊智能答疑命中记录(看板用)。 */
export interface GroupQaStatEntry {
  chatId: string;
  chatName: string;
  question: string;
  sourceTitle: string;
  hash: string;
  at: number; // epoch ms
  upvotes: number;
  downvotes: number;
}
/** 群聊智能答疑「互动节奏」参数(决定机器人频繁还是克制)。 */
export interface GroupQaTuning {
  cooldownSec: number; // 同群两次主动回答最短间隔(秒)
  hourlyCap: number;   // 每群每小时主动回答上限(条)
  dedupMin: number;    // 同一问题多少分钟内不重复答
  demoteDays: number;  // 被👎的问题降权保留天数
  answerCap: number;   // 单条答案字数上限
  aggressiveness: number; // 答疑积极度 1-3(主闸门:1 保守 / 2 适中 / 3 积极,越高越愿意搭话)
}
/** 群消息「AI 点赞」配置(机器人对判定为「好」的群消息自动加飞书表情回复)。 */
export interface GroupQaLike {
  enabled: boolean;         // 总开关
  threshold: number;        // LLM 质量分阈值 1-10(达到才点赞)
  dailyCapPerGroup: number; // 每群每天点赞上限
  cooldownMin: number;      // 同群两次点赞最短间隔(分钟)
  userDailyCap: number;     // 每人每天被点赞上限
  evalDailyBudget: number;  // 每天最多用 LLM 评估多少条(控成本)
  emoji: string;            // 点赞表情(飞书 emoji_type 枚举);smart 模式下为兜底表情
  emojiMode: string;        // "fixed"(固定用 emoji)/ "smart"(AI 按情形选,回退 emoji)
}
/** 一条点赞记录(看板;只存摘要,不落全文)。 */
export interface GroupQaLikeEntry {
  messageId: string;
  chatId: string;
  chatName: string;
  openId: string;
  senderName: string;
  score: number;
  emoji: string;
  preview: string;
  at: number; // epoch ms
}
/** 可选点赞表情(与后端 LIKE_EMOJI_OPTIONS 对齐)。 */
export const GROUP_QA_LIKE_EMOJIS = ["THUMBSUP", "OK", "DONE", "HEART", "APPLAUSE", "FINGERHEART"] as const;

/** 对外显示的模型型号:curated 三段(模型+版本+等级)。 */
export interface ModelDisplayFields { model: string; version: string; level: string }
export interface ModelDisplayConfig {
  claude: ModelDisplayFields;
  codex: ModelDisplayFields;
  showInGroupCard: boolean; // 群答疑卡片是否显示模型
}
/** GET 返回:curated 配置 + 探测到的真实模型(核对提示,可能为 null)。 */
export interface ModelDisplayAdmin extends ModelDisplayConfig {
  detected: { claude: string | null; codex: string | null };
}
