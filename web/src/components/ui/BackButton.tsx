import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/cn";

// 二级页面统一返回按钮:图标样式,放到页面标题最左侧(源自自动化运行详情的方案)。
//   - 传 to  → 路由跳转到该地址
//   - 传 onClick → 自定义行为(如关闭二级视图);两者都传时 onClick 优先
export function BackButton({ to, onClick, label = "返回", className }: {
  to?: string;
  onClick?: () => void;
  label?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const handle = onClick ?? (() => { if (to) navigate(to); });
  return (
    <button type="button" onClick={handle} aria-label={label} title={label}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-fg transition hover:bg-surface",
        className,
      )}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
    </button>
  );
}
