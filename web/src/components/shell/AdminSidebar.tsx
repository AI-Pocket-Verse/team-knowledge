import { NavLink, Link } from "react-router-dom";
import { Home } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAdminAccess } from "@/lib/adminAccess";
import { BrandHeader } from "@/components/shell/Brand";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT } from "@/i18n";

// 系统管理侧栏。所有页面均为管理员专属(文件夹在工作区侧栏内联管理,不在此处),
// 故非管理员看不到任何条目。数据看板不在此(已移到头像菜单,对所有用户可见)。
// 条目按职能分组,每组带一个小标题,便于在条目变多后快速定位。
const buildGroups = (): { title: string; items: { to: string; label: string }[] }[] => [
  {
    title: tr("shell.admin.group.members"),
    items: [
      { to: "/admin/users", label: tr("shell.page.users") },
      { to: "/admin/roles", label: tr("shell.page.roles") },
      { to: "/admin/page-visibility", label: tr("shell.page.pageVisibility") },
    ],
  },
  {
    title: tr("app.productName"),
    items: [
      { to: "/admin/assistant-filter", get label() { return tr("shell.page.assistantFilter", { name: getAssistantName() }); } },
      { to: "/admin/article-review", label: tr("shell.page.articleReview") },
      { to: "/admin/group-qa", label: tr("shell.page.groupQa") },
      { to: "/admin/experts", label: tr("shell.page.experts") },
    ],
  },
  {
    title: tr("shell.admin.group.aiVoice"),
    items: [
      { to: "/admin/ai-provider", label: tr("shell.page.aiProvider") },
      { to: "/admin/voice", label: tr("shell.page.voice") },
    ],
  },
  {
    title: tr("shell.admin.group.integrations"),
    items: [
      { to: "/admin/github", label: tr("shell.page.github") },
      { to: "/admin/feishu-tasks", label: tr("shell.page.feishuTasks") },
      { to: "/admin/web-notify", label: tr("shell.page.webNotify") },
    ],
  },
  {
    title: tr("shell.admin.group.ops"),
    items: [
      { to: "/admin/weekly-report", label: tr("shell.page.weeklyReport") },
      { to: "/admin/backup", label: tr("shell.page.backup") },
    ],
  },
];

export function AdminSidebar() {
  const t = useT();
  const GROUPS = buildGroups();
  const access = useAdminAccess();
  // 管理员看到全部条目;普通用户只看到「已放开给所有成员」的页面;空分组隐藏。
  const pageKeyOf = (to: string) => to.replace("/admin/", "");
  const visibleGroups = GROUPS
    .map((g) => ({ ...g, items: g.items.filter((it) => access.isAdmin || access.openPages.includes(pageKeyOf(it.to))) }))
    .filter((g) => g.items.length > 0);
  return (
    <aside
      // 两栏布局下侧栏是 h-screen 行的 flex 子项,自动撑满全高;内容过多时自身
      // 纵向滚动(brand + 分组导航全在一个滚动区,导航再长也不会被裁切)。
      // 宽度对齐主界面工作区侧栏的默认宽度(WorkspaceLeftRail RAIL_DEFAULT_WIDTH = 300),
      // 保证从工作区进出管理后台时左栏宽度不跳变。
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface p-4"
    >
      {/* 品牌头(飞书:品牌在侧栏最顶)+ 返回首页图标(放标题行最右,
          仿主界面左栏标题右侧图标的位置/大小:h-8 w-8 按钮 + 18px 图标)。
          pr-2:让图标右边缘距侧栏右沿 8px,与主界面左栏(px-2)标题右侧图标完全对齐。 */}
      <div className="-mx-4 -mt-4 mb-3 flex h-16 items-center pr-2">
        <BrandHeader />
        <Link
          to="/"
          aria-label={t("shell.nav.backHome")}
          title={t("shell.nav.backHome")}
          className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-blue-50/60 hover:text-primary"
        >
          <Home className="h-[18px] w-[18px]" />
        </Link>
      </div>
      {access.canEnter && (
        <nav className="flex flex-col gap-5">
          {visibleGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              {/* 分类标题:用淡品牌色 + 小号大写,区别于下方灰色导航项,克制不抢眼(不加分隔线)。 */}
              <div className="mb-0.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-primary/60">
                {group.title}
              </div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      // 条目相对分类标题(px-3=12px)再向右缩进,内容嵌套在标题之下。
                      "rounded-lg py-2 pl-5 pr-3 text-sm transition",
                      isActive
                        ? "bg-accent-soft font-semibold text-primary"
                        : "text-muted hover:bg-blue-50/60 hover:text-primary",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      )}
    </aside>
  );
}
