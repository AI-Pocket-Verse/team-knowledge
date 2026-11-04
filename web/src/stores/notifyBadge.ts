import { create } from "zustand";

// 跨组件徽标同步(与 useWorkspaceTree / useMeetingBadge 同款桥接):
// 文章详情页打开后会把该文章相关的未读通知标记已读,服务端返回最新
// 未读数 —— 通过这里推给头部铃铛(NotificationBell),红点立即更新,
// 不用等铃铛 30s 的轮询。`nonce` 让相同的未读数也能再次触发铃铛的
// effect(例:标读后又来了新通知,数值恰好相同)。
interface NotifyBadgeState {
  nonce: number;
  /** 服务端权威未读数;null = 还没有页面推过(铃铛维持自己的轮询值)。 */
  unread: number | null;
  pushUnread: (unread: number) => void;
}

export const useNotifyBadge = create<NotifyBadgeState>((set) => ({
  nonce: 0,
  unread: null,
  pushUnread: (unread) => set((s) => ({ nonce: s.nonce + 1, unread })),
}));
