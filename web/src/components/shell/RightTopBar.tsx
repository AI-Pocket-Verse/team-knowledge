import { Link, useLocation } from "react-router-dom";
import { HeaderSearch } from "@/components/shell/HeaderSearch";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { UserMenu } from "@/components/shell/UserMenu";
import { usePageChromeStore } from "@/stores/pageChrome";
import { useChatStore } from "@/stores/chat";
import { getAssistantName } from "@/lib/assistantName";
import { tr } from "@/i18n";

// 右栏顶栏(取代原全宽 header)。左:页面标题 / 面包屑(动态页用 pageChrome,
// 简单页靠下面的路由兜底);右:固定 [搜索 通知 头像]。文档详情等会经 pageChrome
// 提供面包屑 + 分享动作。
// 助手聊天面是「会话」语义:新对话 / 落地页显示「助手」,进入具体会话后显示该会话标题
//(与左栏对话列表里的标题/回退完全一致)。具体标题取值见 RightTopBar 内的 chatTitle()。
const ROUTE_TITLES: { test: (p: string) => boolean; title: string }[] = [
  { test: (p) => p === "/" || p === "/c/new" || p.startsWith("/c/"), get title() { return `${getAssistantName()}`; } },
  { test: (p) => p === "/bookmarks", get title() { return tr("shell.page.bookmarks"); } },
  { test: (p) => p === "/meeting" || p.startsWith("/meeting/"), get title() { return tr("shell.page.meeting"); } },
  { test: (p) => p === "/automation", get title() { return tr("shell.page.automation"); } },
  { test: (p) => p === "/dashboard", get title() { return tr("shell.page.dashboard"); } },
  { test: (p) => p === "/experts", get title() { return tr("shell.page.expertsPage"); } },
  { test: (p) => p === "/me/escalations", get title() { return tr("shell.page.myTodos"); } },
  { test: (p) => p === "/me/profile", get title() { return tr("shell.page.profile"); } },
  { test: (p) => p === "/recycle-bin", get title() { return tr("shell.page.recycleBin"); } },
  { test: (p) => p === "/about", get title() { return tr("shell.page.about"); } },
  { test: (p) => p.startsWith("/admin/users"), get title() { return tr("shell.page.users"); } },
  { test: (p) => p.startsWith("/admin/roles"), get title() { return tr("shell.page.roles"); } },
  { test: (p) => p.startsWith("/admin/ai-provider"), get title() { return tr("shell.page.aiProviderTop"); } },
  { test: (p) => p.startsWith("/admin/voice"), get title() { return tr("shell.page.voice"); } },
  { test: (p) => p.startsWith("/admin/github"), get title() { return tr("shell.page.github"); } },
  { test: (p) => p.startsWith("/admin/backup"), get title() { return tr("shell.page.backup"); } },
  { test: (p) => p.startsWith("/admin/weekly-report"), get title() { return tr("shell.page.weeklyReport"); } },
  { test: (p) => p.startsWith("/admin/feishu-tasks"), get title() { return tr("shell.page.feishuTasks"); } },
  { test: (p) => p.startsWith("/admin/group-qa"), get title() { return tr("shell.page.groupQa"); } },
  { test: (p) => p.startsWith("/admin/assistant-filter"), get title() { return tr("shell.page.assistantFilter", { name: getAssistantName() }); } },
  { test: (p) => p.startsWith("/admin/article-review"), get title() { return tr("shell.page.articleReview"); } },
  { test: (p) => p.startsWith("/admin/page-visibility"), get title() { return tr("shell.page.pageVisibility"); } },
  { test: (p) => p.startsWith("/admin/web-notify"), get title() { return tr("shell.page.webNotify"); } },
  { test: (p) => p.startsWith("/admin/experts"), get title() { return tr("shell.page.experts"); } },
];

function routeTitle(pathname: string): string {
  return ROUTE_TITLES.find((r) => r.test(pathname))?.title ?? "";
}

export function RightTopBar() {
  const { pathname } = useLocation();
  const chrome = usePageChromeStore((s) => s.chrome);
  const conversationId = useChatStore((s) => s.conversationId);
  const conversations = useChatStore((s) => s.conversations);
  const activeTitle = useChatStore((s) => s.activeTitle);
  const activeIsFeishu = useChatStore((s) => s.activeIsFeishu);

  // 聊天路由(/、/c/new、/c/:id)下的标题:
  //   - 无当前会话(助手落地页 / 新对话尚未落定)→ 空(落地页中央已有大标题,顶栏不再重复「助手」)
  //   - 有当前会话 → 该会话标题,回退与左栏列表一致(无标题 → 飞书「飞书对话」/ 普通「新对话」)
  function chatTitle(): string {
    if (!conversationId) return "";
    const item = conversations.find((c) => c.id === conversationId);
    const title = item ? item.title : activeTitle;
    const isFeishu = item ? item.isFeishu : activeIsFeishu;
    return title?.trim() || (isFeishu ? tr("shell.top.feishuChat") : tr("shell.top.newChat"));
  }
  const isChatRoute = pathname === "/" || pathname.startsWith("/c/");
  const fallbackTitle = isChatRoute ? chatTitle() : routeTitle(pathname);

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 bg-bg px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {chrome?.breadcrumb ? (
          <nav className="flex min-w-0 items-center gap-1.5 text-[15px]">
            {chrome.breadcrumb.map((seg, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && <span className="shrink-0 text-muted">›</span>}
                {seg.to ? (
                  <Link to={seg.to} className="shrink-0 text-muted transition hover:text-fg">
                    {seg.label}
                  </Link>
                ) : (
                  <span
                    className={
                      i === chrome.breadcrumb!.length - 1
                        ? "truncate font-medium text-fg"
                        : "shrink-0 text-muted"
                    }
                  >
                    {seg.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        ) : (
          <h1 className="min-w-0 truncate text-[19px] font-semibold text-fg">
            {chrome?.title || fallbackTitle}
          </h1>
        )}
      </div>
      {chrome?.rightActions && (
        <div className="flex shrink-0 items-center gap-2">{chrome.rightActions}</div>
      )}
      <div className="flex shrink-0 items-center gap-3">
        <HeaderSearch />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
