import { create } from "zustand";
import type { User } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { setAssistantName } from "@/lib/assistantName";
import { ssoLoginUrl } from "@/lib/sso";

// 管理后台可访问信息。一次拉取、全局共享(头像菜单 / 侧栏 / 路由守卫共用),
// 避免每个组件各发一次 /api/me/admin-access。null = 登录用户但尚未拉到(加载中)。
export interface AdminAccessInfo { isAdmin: boolean; openPages: string[]; }

interface AuthState {
  user: User | null;
  status: "idle" | "loading" | "ready";
  error: string | null;
  // 登录后异步填充;失败时回退为 { isAdmin: 取自 /api/me, openPages: [] },
  // 以保证管理员永不因 admin-access 这一次请求抖动被踢出后台。
  adminAccess: AdminAccessInfo | null;
  bootstrap: () => Promise<void>;
  refreshAdminAccess: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User | null) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  status: "idle",
  error: null,
  adminAccess: null,
  async bootstrap() {
    set({ status: "loading", error: null });
    try {
      // The local team-knowledge user (SSO-backed, JIT-provisioned server-side on
      // the first authenticated request). null = not logged in via SSO.
      const { user, assistantName } = await api.me();
      setAssistantName(assistantName);
      set({ user, status: "ready", adminAccess: null });
      // 登录后拉取管理后台可访问信息(不阻塞首屏);未登录则保持 null。
      if (user) void get().refreshAdminAccess();
    } catch (e) {
      // 区分「确定未登录」与「瞬时故障」。改代码触发 API 热重启(tsx watch)时,
      // /api/me 会短暂连不上(网络错误 status 0)或 5xx —— 此时会话其实仍有效,
      // 绝不能误判为未登录而 status:"ready"+user:null → 触发门控跳登录。
      // 瞬时故障:保持加载态并自动重试(API 起来后 bootstrap 会成功)。
      // 真·未登录是 401(已由 api 层直接重定向到 SSO 登录),走下面的 ready+null。
      const status = (e as { status?: number }).status;
      if (status === 0 || (typeof status === "number" && status >= 500 && status < 600)) {
        set({ status: "loading", error: (e as Error).message });
        window.setTimeout(() => { void get().bootstrap(); }, 2000);
        return;
      }
      set({ user: null, status: "ready", error: (e as Error).message, adminAccess: null });
    }
  },
  async refreshAdminAccess() {
    const u = get().user;
    if (!u) { set({ adminAccess: null }); return; }
    try {
      const r = await api.adminAccess();
      set({ adminAccess: { isAdmin: r.isAdmin, openPages: r.openPages } });
    } catch {
      // 兜底:信任 /api/me 的 isAdmin,使 admin-access 这一次请求失败时
      // 管理员仍能进入后台(openPages 未知 → 视为无放开页)。
      set({ adminAccess: { isAdmin: !!u.isAdmin, openPages: [] } });
    }
  },
  async logout() {
    try { await api.logout(); } catch { /* ignore — we still want to log out locally */ }
    set({ user: null, adminAccess: null });
    // api.logout() already POSTed /auth/api/logout to clear sso_session. Now send
    // the browser to the branded SSO login landing — a real GET page. (Do NOT
    // navigate to /api/logout: that route is POST-only, so a GET navigation
    // would land the user on a 404 instead of the login screen.)
    window.location.assign(ssoLoginUrl());
  },
  setUser(u) {
    set({ user: u });
  },
}));

export const useIsAdmin = () => useAuth((s) => !!s.user?.isAdmin);
