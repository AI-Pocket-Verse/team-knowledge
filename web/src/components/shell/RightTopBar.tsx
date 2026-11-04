import { Link, useLocation } from "react-router-dom";
import { HeaderSearch } from "@/components/shell/HeaderSearch";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { UserMenu } from "@/components/shell/UserMenu";
import { usePageChromeStore } from "@/stores/pageChrome";
import { useChatStore } from "@/stores/chat";
import { getAssistantName } from "@/lib/assistantName";

// 右栏顶栏(取代原全宽 header)。左:页面标题 / 面包屑(动态页用 pageChrome,
// 简单页靠下面的路由兜底);右:固定 [搜索 通知 头像]。文档详情等会经 pageChrome
// 提供面包屑 + 分享动作。
// 助手聊天面是「会话」语义:新对话 / 落地页显示「助手」,进入具体会话后显示该会话标题
//(与左栏对话列表里的标题/回退完全一致)。具体标题取值见 RightTopBar 内的 chatTitle()。
const ROUTE_TITLES: { test: (p: string) => boolean; title: string }[] = [
  { test: (p) => p === "/" || p === "/c/new" || p.startsWith("/c/"), get title() { return `${getAssistantName()}`; } },
  { test: (p) => p === "/bookmarks", title: "收藏" },
  { test: (p) => p === "/meeting" || p.startsWith("/meeting/"), title: "会议" },
  { test: (p) => p === "/automation", title: "自动化" },
  { test: (p) => p === "/dashboard", title: "数据看板" },
  { test: (p) => p === "/experts", title: "专家" },
  { test: (p) => p === "/me/escalations", title: "我的待办" },
  { test: (p) => p === "/me/profile", title: "个人主页" },
  { test: (p) => p === "/recycle-bin", title: "回收站" },
  { test: (p) => p === "/about", title: "关于" },
  { test: (p) => p.startsWith("/admin/users"), title: "用户" },
  { test: (p) => p.startsWith("/admin/roles"), title: "角色" },
  { test: (p) => p.startsWith("/admin/ai-provider"), title: "AI 提供方" },
  { test: (p) => p.startsWith("/admin/voice"), title: "语音引擎" },
  { test: (p) => p.startsWith("/admin/github"), title: "GitHub 仓库" },
  { test: (p) => p.startsWith("/admin/backup"), title: "备份/还原" },
  { test: (p) => p.startsWith("/admin/weekly-report"), title: "周报" },
  { test: (p) => p.startsWith("/admin/feishu-tasks"), title: "飞书群任务" },
  { test: (p) => p.startsWith("/admin/group-qa"), title: "群答疑记录" },
  { test: (p) => p.startsWith("/admin/assistant-filter"), get title() { return `${getAssistantName()} 内容过滤`; } },
  { test: (p) => p.startsWith("/admin/article-review"), title: "文档校验" },
  { test: (p) => p.startsWith("/admin/page-visibility"), title: "页面可见性" },
  { test: (p) => p.startsWith("/admin/web-notify"), title: "Web 通知" },
  { test: (p) => p.startsWith("/admin/experts"), title: "专家设定" },
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
    return title?.trim() || (isFeishu ? "飞书对话" : "新对话");
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
