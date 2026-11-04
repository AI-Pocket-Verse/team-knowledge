// 浏览器桌面通知(Web Notification API)工具:授权探测/主动申请 + 弹通知。
// 用在两处:① WebNotifier 轮询到新「事件完成」通知时弹桌面;② 通知设置面板里
// 用户打开「浏览器通知」开关时主动申请授权。所有失败一律静默,绝不抛。

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notifyPermission(): NotificationPermission {
  return notifySupported() ? Notification.permission : "denied";
}

/** 主动申请授权。仅在 permission==="default" 时才弹系统询问;已授权/已拒绝直接回当前值。
 *  Safari 要求在用户手势里调用(故通知设置面板的开关会触发这里);Chrome 允许程序化调用。 */
export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!notifySupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface WebNotifItem { createdAt: string; id: string; readAt: string | null }

/** 纯决策(便于单测):给定当前 Web 通知列表(后端倒序:新→旧)与上次基线游标,
 *  算出「应弹的条目(时间正序)」与「下一个基线游标」。游标 = `createdAt|id`,字典序比较
 *  天然按 (createdAt, id) 排序,处理同毫秒不同 id 的边界。
 *
 *  - lastSeen===null(首次):建立基线、不补弹历史 → fire=[],nextCursor=最新(空列表则哨兵 "");
 *  - 列表为空但已有基线:nextCursor=null(不用空列表覆盖已有基线);
 *  - 其余:fire=比基线更新且未读者,nextCursor=最新。 */
export function decideDesktopNotifications<T extends WebNotifItem>(
  web: T[],
  lastSeen: string | null,
): { fire: T[]; nextCursor: string | null } {
  const cursorOf = (n: WebNotifItem) => `${n.createdAt}|${n.id}`;
  const newestCursor = web.length ? cursorOf(web[0]!) : "";
  if (lastSeen === null) return { fire: [], nextCursor: newestCursor };
  if (web.length === 0) return { fire: [], nextCursor: null };
  const fire = web.filter((n) => cursorOf(n) > lastSeen && !n.readAt).reverse();
  return { fire, nextCursor: newestCursor };
}

/** 弹一条系统桌面通知。tag 用于跨标签页去重(相同 tag 系统只保留一条)。
 *  未授权 / 不支持 → 静默不弹。 */
export function showDesktopNotification(
  title: string,
  opts: { body?: string; tag?: string; onClick?: () => void } = {},
): void {
  if (!notifySupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: opts.body, tag: opts.tag });
    if (opts.onClick) {
      n.onclick = () => {
        window.focus();
        opts.onClick?.();
        n.close();
      };
    }
  } catch {
    /* 某些环境(如需 ServiceWorker 的场景)直接 new Notification 会抛,忽略即可 */
  }
}
