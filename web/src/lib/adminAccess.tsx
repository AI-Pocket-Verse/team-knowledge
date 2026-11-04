import { type ReactElement } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";

// 白名单页面 key → 路由路径(用于「首个可访问页」跳转与按 key 的路由守卫)。
export const ADMIN_PAGE_ROUTES: Record<string, string> = {
  "article-review": "/admin/article-review",
  "group-qa": "/admin/group-qa",
  "weekly-report": "/admin/weekly-report",
};

/** 进入管理后台时落到哪个页:管理员 → 用户;普通用户 → 其第一个已放开页。 */
export function firstAdminPath(isAdmin: boolean, openPages: string[]): string {
  if (isAdmin) return "/admin/users";
  const first = openPages[0];
  return (first && ADMIN_PAGE_ROUTES[first]) || "/";
}

export interface AdminAccess { isAdmin: boolean; openPages: string[]; canEnter: boolean; loading: boolean; }

/**
 * 当前用户的管理后台可访问信息。纯选择器:读取 auth store 里一次性拉取并全局
 * 共享的 adminAccess(见 stores/auth.ts 的 refreshAdminAccess),不再每个组件各发
 * 一次 /api/me/admin-access。openPages = 已放开给所有成员的白名单页。
 * loading:登录但 admin-access 尚未拉到(null)时为 true,守卫据此显示加载态而非误跳转。
 */
export function useAdminAccess(): AdminAccess {
  const status = useAuth((s) => s.status);
  const userId = useAuth((s) => s.user?.id ?? null);
  const access = useAuth((s) => s.adminAccess);

  const loading = status !== "ready" || (!!userId && access === null);
  const isAdmin = access?.isAdmin ?? false;
  const openPages = access?.openPages ?? [];
  return { isAdmin, openPages, loading, canEnter: isAdmin || openPages.length > 0 };
}

/** 单页守卫:管理员或该页已放开才渲染;否则跳到首个可访问页 / 首页。 */
export function RequireAdminPage({ pageKey, children }: { pageKey: string; children: ReactElement }) {
  const a = useAdminAccess();
  if (a.loading) return <DelayedLoader />;
  if (a.isAdmin || a.openPages.includes(pageKey)) return children;
  return <Navigate to={firstAdminPath(a.isAdmin, a.openPages)} replace />;
}
