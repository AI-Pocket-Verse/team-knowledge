import { Link } from "react-router-dom";
import { Home } from "lucide-react";
import { BookFlipIcon } from "@/components/shell/BookFlipIcon";
import { CURRENT_VERSION } from "@/lib/changelog";

// 侧栏顶部品牌块。collapsed 时只显示图标(配合可收起的左栏)。
// compact:与左栏「收起」图标并排时用更小的左内边距,让 logo 紧挨收起按钮(仿飞书云文档)。
export function BrandHeader({ collapsed = false, compact = false }: { collapsed?: boolean; compact?: boolean }) {
  return (
    <Link
      to="/"
      title="团队知识库"
      className={`flex h-16 shrink-0 items-center transition hover:opacity-80 ${
        collapsed ? "justify-center px-0" : compact ? "gap-2 px-1" : "gap-2 px-4"
      }`}
    >
      <BookFlipIcon className="h-7 w-7 shrink-0 text-primary" />
      {!collapsed && (
        <>
          <span className="whitespace-nowrap text-[17px] font-bold tracking-tight text-fg">团队知识库</span>
          <span className="mt-0.5 whitespace-nowrap text-[11px] font-normal text-muted">v{CURRENT_VERSION}</span>
        </>
      )}
    </Link>
  );
}

// 无目录树的全宽页(个人主页/回收站/关于/看板)用的细品牌条:品牌 + 返回首页图标。
// 宽度 + 品牌块(含返回首页图标)必须与 AdminSidebar【完全一致】(同为 w-[300px] + p-4,
// 品牌块用 -mx-4 -mt-4 顶到左上角、返回首页放标题行最右的 h-8 w-8 图标),否则在
// 「看板↔管理后台」等页面间切换时 logo/标题/图标会跳动。
export function BrandStrip() {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-surface p-4">
      <div className="-mx-4 -mt-4 mb-3 flex h-16 items-center pr-2">
        <BrandHeader />
        <Link
          to="/"
          aria-label="返回首页"
          title="返回首页"
          className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-blue-50/60 hover:text-primary"
        >
          <Home className="h-[18px] w-[18px]" />
        </Link>
      </div>
    </aside>
  );
}
