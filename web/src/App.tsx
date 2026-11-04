import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useAuth } from "@/stores/auth";
import { redirectToSsoLogin } from "@/lib/sso";
import { useAdminAccess, firstAdminPath, RequireAdminPage } from "@/lib/adminAccess";
import { WorkspaceEntry } from "@/pages/WorkspaceEntry";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { ArticleListPage } from "@/pages/ArticleListPage";
import { RolePage } from "@/pages/RolePage";
import { BookmarksPage } from "@/pages/BookmarksPage";
import { AdminShell } from "@/components/shell/AdminShell";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { MeetingSessionHost } from "@/components/meeting/MeetingSessionHost";
import { WebNotifier } from "@/components/shell/WebNotifier";
import { Toaster } from "@/components/Toaster";
import { DialogHost } from "@/components/Dialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DelayedLoader } from "@/components/DelayedLoader";
import { getAssistantName } from "@/lib/assistantName";

// Code-splitting: the editor stack (Milkdown / crepe / highlight.js)
// and the meeting realtime libs were the bulk of a single ~2.2MB entry
// chunk. Lazy-loading the heavy / less-common pages moves that code into
// separate chunks that only download when the user navigates to them, so
// the first paint (workspace home) ships far less JS. The eagerly-imported
// pages above are the cheap, always-on landing surfaces; everything below
// is route-gated behind React.lazy + a Suspense boundary.
const NewArticleRedirect = lazy(() =>
  import("@/pages/NewArticleRedirect").then((m) => ({ default: m.NewArticleRedirect })),
);
const ArticlePage = lazy(() =>
  import("@/pages/ArticlePage").then((m) => ({ default: m.ArticlePage })),
);
const ProfilePage = lazy(() =>
  import("@/pages/ProfilePage").then((m) => ({ default: m.ProfilePage })),
);
const PublicProfilePage = lazy(() =>
  import("@/pages/PublicProfilePage").then((m) => ({ default: m.PublicProfilePage })),
);
const RecycleBinPage = lazy(() =>
  import("@/pages/RecycleBinPage").then((m) => ({ default: m.RecycleBinPage })),
);
const AboutPage = lazy(() =>
  import("@/pages/AboutPage").then((m) => ({ default: m.AboutPage })),
);
const MeetingHubPage = lazy(() =>
  import("@/pages/MeetingHubPage").then((m) => ({ default: m.MeetingHubPage })),
);
const AutomationPage = lazy(() =>
  import("@/pages/AutomationPage").then((m) => ({ default: m.AutomationPage })),
);
const MeetingCreatePage = lazy(() =>
  import("@/pages/MeetingCreatePage").then((m) => ({ default: m.MeetingCreatePage })),
);
const MeetingRoomPage = lazy(() =>
  import("@/pages/MeetingRoomPage").then((m) => ({ default: m.MeetingRoomPage })),
);
const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const AdminUsersPage = lazy(() =>
  import("@/pages/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })),
);
const AdminRolesPage = lazy(() =>
  import("@/pages/AdminRolesPage").then((m) => ({ default: m.AdminRolesPage })),
);
const AdminAiProviderPage = lazy(() =>
  import("@/pages/AdminAiProviderPage").then((m) => ({ default: m.AdminAiProviderPage })),
);
const AdminVoiceEnginePage = lazy(() =>
  import("@/pages/AdminVoiceEnginePage").then((m) => ({ default: m.AdminVoiceEnginePage })),
);
const AdminGithubPage = lazy(() =>
  import("@/pages/AdminGithubPage").then((m) => ({ default: m.AdminGithubPage })),
);
const AdminBackupPage = lazy(() =>
  import("@/pages/AdminBackupPage").then((m) => ({ default: m.AdminBackupPage })),
);
const AdminFeishuTasksPage = lazy(() =>
  import("@/pages/AdminFeishuTasksPage").then((m) => ({ default: m.AdminFeishuTasksPage })),
);
const AdminGroupQaPage = lazy(() =>
  import("@/pages/AdminGroupQaPage").then((m) => ({ default: m.AdminGroupQaPage })),
);
const AdminAssistantFilterPage = lazy(() =>
  import("@/pages/AdminAssistantFilterPage").then((m) => ({ default: m.AdminAssistantFilterPage })),
);
const AdminArticleReviewPage = lazy(() =>
  import("@/pages/AdminArticleReviewPage").then((m) => ({ default: m.AdminArticleReviewPage })),
);
const AdminPageVisibilityPage = lazy(() =>
  import("@/pages/AdminPageVisibilityPage").then((m) => ({ default: m.AdminPageVisibilityPage })),
);
const AdminWebNotifyPage = lazy(() =>
  import("@/pages/AdminWebNotifyPage").then((m) => ({ default: m.AdminWebNotifyPage })),
);
const ExpertEscalationsPage = lazy(() =>
  import("@/pages/ExpertEscalationsPage").then((m) => ({ default: m.ExpertEscalationsPage })),
);
const AdminExpertConfigPage = lazy(() =>
  import("@/pages/AdminExpertConfigPage").then((m) => ({ default: m.AdminExpertConfigPage })),
);
const AdminWeeklyReportPage = lazy(() =>
  import("@/pages/AdminWeeklyReportPage").then((m) => ({ default: m.AdminWeeklyReportPage })),
);
const AdminWeeklyReportDetailPage = lazy(() =>
  import("@/pages/AdminWeeklyReportDetailPage").then((m) => ({ default: m.AdminWeeklyReportDetailPage })),
);

// Map the in-flight route to a human label so a slow lazy-chunk download tells
// the user WHICH surface is loading (the editor bundle is the heavy one) instead
// of a vague "加载中…". The chunk = that page's real component, so this names it.
function routeLabel(path: string): string {
  if (path === "/d/new") return "新建文档";
  if (path.startsWith("/d/")) return "文档";
  if (path.startsWith("/dashboard")) return "数据看板";
  if (path.startsWith("/admin/weekly-report")) return "周报";
  if (path.startsWith("/admin/feishu-tasks")) return "飞书群任务";
  if (path.startsWith("/admin/group-qa")) return "群答疑记录";
  if (path.startsWith("/admin/assistant-filter")) return `${getAssistantName()} 内容过滤`;
  if (path.startsWith("/admin/ai-provider")) return "AI 引擎";
  if (path.startsWith("/admin/voice")) return "语音引擎";
  if (path.startsWith("/admin/github")) return "GitHub 仓库";
  if (path.startsWith("/admin")) return "管理后台";
  if (path.startsWith("/meeting")) return "会议";
  if (path.startsWith("/u/") || path.startsWith("/me/profile")) return "个人主页";
  if (path.startsWith("/recycle-bin")) return "回收站";
  if (path.startsWith("/about")) return "关于";
  if (path.startsWith("/bookmarks")) return "收藏";
  return "知识库";
}

// Loader shown while a lazy route chunk downloads — the same centered
// DelayedLoader the pages and route guards use, so a chunk fetch reads as one
// unified loading affordance, now captioned with which surface is loading.
function RouteFallback() {
  const { pathname } = useLocation();
  return <DelayedLoader label={`正在加载${routeLabel(pathname)}…`} />;
}

// Local-auth gate. SSO owns login; an unauthenticated visitor (no local
// user after the /api/me bootstrap) is bounced to the SSO landing rather
// than an in-app /login route.
function RequireWorkspace({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  if (status !== "ready") return <DelayedLoader />;
  if (!user) {
    redirectToSsoLogin();
    return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">跳转登录中…</div>;
  }
  return <>{children}</>;
}

// Legacy doc URL shim. Internal links inserted before the canonical doc
// route was unified on `/d/:docId` used `/a/<id>`, and there's no `/a/:id`
// route — so those saved links would 404. Redirect them to the real doc
// view (`/d/:docId`) so old references keep resolving. `replace` keeps the
// stale `/a/` URL out of history.
function LegacyArticleRedirect() {
  const { docId } = useParams<{ docId: string }>();
  return <Navigate to={`/d/${docId}`} replace />;
}

// /d/:id/edit 旧编辑链接 → 统一文档页(看即可改,无独立编辑页)。
function EditRedirect() {
  const { docId } = useParams<{ docId: string }>();
  return <Navigate to={`/d/${docId}`} replace />;
}

function AdminIndexRedirect() {
  // 管理员 → 用户;普通用户 → 其第一个已放开的页面(全凭 admin-access)。
  const access = useAdminAccess();
  if (access.loading) return <DelayedLoader />;
  return <Navigate to={firstAdminPath(access.isAdmin, access.openPages)} replace />;
}

function RequireManagement() {
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  if (status !== "ready") return <DelayedLoader />;
  if (!user) {
    redirectToSsoLogin();
    return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">跳转登录中…</div>;
  }
  // 能否进入管理后台:管理员,或有任一页面已放开给所有成员(见 admin-access)。
  // 具体每个页面的可见性由各子路由的 RequireAdminPage 守卫,后端再 403 兜底。
  return <RequireManagementInner />;
}

function RequireManagementInner() {
  const access = useAdminAccess();
  if (access.loading) return <DelayedLoader />;
  if (!access.canEnter) return <Navigate to="/" replace />;
  return <AdminShell />;
}

// All list → detail clicks navigate directly to `/d/:docId` — no modal
// overlay, so URLs stay bookmark/share-friendly across the board.
function AppRoutes() {
  // Key the route-level ErrorBoundary on the path so a crash on one page
  // doesn't keep the fallback up after the user navigates elsewhere —
  // changing key remounts the boundary with fresh (error-free) state.
  const location = useLocation();
  return (
    // Inner boundary around the route outlet only: a render throw in any
    // single page shows the fallback in the content area while the app
    // shell (rail / header) keeps working. Suspense supplies the lightweight
    // loader while a lazy route chunk is still downloading.
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<RequireWorkspace><WorkspaceShell /></RequireWorkspace>}>
            <Route path="/" element={<WorkspaceEntry />} />
            {/* 多任务对话深链:/c/:id = 指定会话;/c/new 走同一通配,param="new" → 新对话空态。
                不要再加 /c/new 字面路由,否则它会抢匹配、使 :conversationId 变 undefined,
                导致「新对话」分支永不命中(退化成加载最近一条)。复用首页布局。 */}
            <Route path="/c/:conversationId" element={<WorkspaceEntry />} />
            <Route path="/r/:roleId" element={<RolePage />} />
            <Route path="/f/:folderId" element={<WorkspacePage />}>
              <Route index element={<ArticleListPage />} />
            </Route>
            {/* Doc routes — flat short URLs. /d/new 建空文档后 replace 到 /d/:id;
                /d/:id 看即可改;旧编辑链接 /d/:id/edit 重定向到 /d/:id。 */}
            <Route path="/d/new" element={<NewArticleRedirect />} />
            <Route path="/d/:docId" element={<ArticlePage />} />
            <Route path="/d/:docId/edit" element={<EditRedirect />} />
            {/* Legacy /a/<id> doc links → canonical /d/<id> (no 404). */}
            <Route path="/a/:docId" element={<LegacyArticleRedirect />} />
            <Route path="/bookmarks" element={<BookmarksPage />} />
            {/*助手会议 — hub (everyone) / create (admin) / room (everyone) */}
            <Route path="/meeting" element={<MeetingHubPage />} />
            <Route path="/meeting/new" element={<MeetingCreatePage />} />
            <Route path="/meeting/:id" element={<MeetingRoomPage />} />
            {/* 自动化 — 定时/触发任务入口(目前占位骨架)。 */}
            <Route path="/automation" element={<AutomationPage />} />
          </Route>

          {/* Full-width pages (no workspace tree rail): they aren't scoped to a
              role/folder, so the rail adds nothing. Same header + AI surface. */}
          <Route element={<RequireWorkspace><WorkspaceShell showRail={false} /></RequireWorkspace>}>
            {/* 数据看板 — open to every user (entry lives in the avatar menu,
                above 个人主页). Aggregate content is shown to all; the per-user
                table + drill-down render only for admins (see DashboardPage). */}
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/experts" element={<Navigate to="/" replace />} />
            <Route path="/me/escalations" element={<ExpertEscalationsPage />} />
            <Route path="/me/profile" element={<ProfilePage />} />
            {/* Public per-user profile — any logged-in user can view. */}
            <Route path="/u/:userId" element={<PublicProfilePage />} />
            <Route path="/recycle-bin" element={<RecycleBinPage />} />
            <Route path="/about" element={<AboutPage />} />
          </Route>

          <Route path="/admin" element={<RequireManagement />}>
            <Route index element={<AdminIndexRedirect />} />
            <Route path="users" element={<RequireAdminPage pageKey="users"><AdminUsersPage /></RequireAdminPage>} />
            <Route path="roles" element={<RequireAdminPage pageKey="roles"><AdminRolesPage /></RequireAdminPage>} />
            <Route path="ai-provider" element={<RequireAdminPage pageKey="ai-provider"><AdminAiProviderPage /></RequireAdminPage>} />
            <Route path="voice" element={<RequireAdminPage pageKey="voice"><AdminVoiceEnginePage /></RequireAdminPage>} />
            <Route path="github" element={<RequireAdminPage pageKey="github"><AdminGithubPage /></RequireAdminPage>} />
            <Route path="backup" element={<RequireAdminPage pageKey="backup"><AdminBackupPage /></RequireAdminPage>} />
            <Route path="weekly-report" element={<RequireAdminPage pageKey="weekly-report"><AdminWeeklyReportPage /></RequireAdminPage>} />
            <Route path="weekly-report/:id" element={<RequireAdminPage pageKey="weekly-report"><AdminWeeklyReportDetailPage /></RequireAdminPage>} />
            <Route path="feishu-tasks" element={<RequireAdminPage pageKey="feishu-tasks"><AdminFeishuTasksPage /></RequireAdminPage>} />
            <Route path="group-qa" element={<RequireAdminPage pageKey="group-qa"><AdminGroupQaPage /></RequireAdminPage>} />
            <Route path="assistant-filter" element={<RequireAdminPage pageKey="assistant-filter"><AdminAssistantFilterPage /></RequireAdminPage>} />
            <Route path="article-review" element={<RequireAdminPage pageKey="article-review"><AdminArticleReviewPage /></RequireAdminPage>} />
            <Route path="page-visibility" element={<RequireAdminPage pageKey="page-visibility"><AdminPageVisibilityPage /></RequireAdminPage>} />
            <Route path="web-notify" element={<RequireAdminPage pageKey="web-notify"><AdminWebNotifyPage /></RequireAdminPage>} />
            <Route path="experts" element={<RequireAdminPage pageKey="experts"><AdminExpertConfigPage /></RequireAdminPage>} />
          </Route>

          <Route path="*" element={
            <div className="flex h-screen items-center justify-center text-center">
              <div>
                <h1 className="text-3xl font-semibold">404</h1>
                <p className="mt-2 text-muted">页面未找到</p>
                <Link to="/" className="mt-4 inline-block text-accent underline">返回首页</Link>
              </div>
            </div>
          } />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  useEffect(() => { bootstrap(); }, [bootstrap]);

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Toaster />
      <DialogHost />
      {/* Recording host sits ABOVE the routes (and both shells) so a live
          meeting's mic + WebSocket survive ANY in-app navigation — switching
          sidebar articles (workspace shell) AND opening 系统设置 (admin shell),
          which live in different shells that would otherwise unmount it. */}
      <MeetingSessionHost>
        {/* 常驻的桌面通知器:任务/纪要/生图完成时弹浏览器系统通知(切走标签页也能被叫回)。
            渲染 null,挂在路由树内(要用 useNavigate),不随页面切换卸载。 */}
        <WebNotifier />
        {/* Outer boundary around the whole routed app — last line of defense
            so even a crash in a shell (rail/header) shows the fallback
            instead of white-screening the entire SPA. */}
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
      </MeetingSessionHost>
    </BrowserRouter>
  );
}
