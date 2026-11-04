import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { requestNotifyPermission, showDesktopNotification, notifyPermission, decideDesktopNotifications } from "@/lib/webNotify";
import { tr } from "@/i18n";

// 全局「事件完成」桌面通知器。挂在路由树里常驻(不随页面切换卸载),周期性拉取通知列表,
// 发现新的 Web 通知类(automation_run / meeting_minutes / image_gen)就弹一条浏览器桌面通知。
// 站内铃铛负责「可回看」,这里负责「切走标签页也能被叫回来」。渲染 null,无 UI。
//
// 桌面弹窗仅在标签页【不在前台】时弹(document.hidden):用户正盯着看就不打扰,只留铃铛记录;
// 切走标签页 / 最小化后完成的任务才弹系统通知。
//
// 去重/防补弹:用 localStorage 记「上次见过的最新一条游标(createdAt|id)」。首次挂载只建立
// 基线、不补弹历史(空列表也写哨兵基线,否则第一条通知会被当基线吞掉);之后仅对比基线
// 更严格更新且未读的条目弹窗,tag=id 让多标签页只弹一条。
const WEB_TYPES = new Set(["automation_run", "meeting_minutes", "image_gen"]);
const POLL_MS = 30_000;
const lsKey = (uid: string) => `webnotif:lastSeen:${uid}`;

export function WebNotifier() {
  const nav = useNavigate();
  const userId = useAuth((s) => s.user?.id ?? null);
  const navRef = useRef(nav);
  navRef.current = nav;
  // 每用户的桌面弹窗总开关(webEnabled)。关掉则铃铛照常、只是不弹系统通知。每轮重读,
  // 用户中途在「通知设置」里关掉能即时生效(不必刷新)。
  const webEnabledRef = useRef(true);

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let askedPermission = false;

    const seenKey = lsKey(userId);
    const readLastSeen = (): string | null => {
      try { return localStorage.getItem(seenKey); } catch { return null; }
    };
    const writeLastSeen = (v: string): void => {
      try { localStorage.setItem(seenKey, v); } catch { /* 隐私模式等写不了,忽略 */ }
    };

    // 每轮刷新 webEnabled;首次(且允许时)主动申请一次通知授权(default 才会弹询问)。
    const refreshPrefs = async (): Promise<void> => {
      try {
        const p = await api.notifications.getPrefs();
        webEnabledRef.current = p.webEnabled;
        if (p.webEnabled && !askedPermission && notifyPermission() === "default") {
          askedPermission = true;
          void requestNotifyPermission();
        }
      } catch { /* 忽略,下轮再来 */ }
    };

    const tick = async (): Promise<void> => {
      await refreshPrefs();
      try {
        const { notifications } = await api.notifications.list();
        const web = notifications.filter((n) => WEB_TYPES.has(n.type));
        const { fire, nextCursor } = decideDesktopNotifications(web, readLastSeen());
        // 桌面弹窗:开启 + 已授权 + 标签页不在前台。铃铛记录不受这些影响(后端已落行)。
        if (fire.length && webEnabledRef.current && notifyPermission() === "granted" && document.visibilityState === "hidden") {
          for (const n of fire) {
            showDesktopNotification(n.title ?? tr("shell.notifier.default"), {
              body: n.body ?? undefined,
              tag: n.id,
              onClick: () => { if (n.link) navRef.current(n.link); },
            });
          }
        }
        if (nextCursor !== null) writeLastSeen(nextCursor);
      } catch {
        /* 网络抖动:忽略,下个 tick 再来 */
      }
    };

    void tick();
    const timer = window.setInterval(() => { if (!stopped) void tick(); }, POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [userId]);

  return null;
}
