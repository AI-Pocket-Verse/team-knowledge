import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, EditLockConflictError, API_BASE } from "@/lib/api";
import { toast } from "@/components/Toaster";

export interface UseEditLockResult {
  /** 是否已进入编辑(持有软锁)。 */
  editing: boolean;
  /** 是否因他人正持有活动锁而被挡(应切回只读)。 */
  lockedByOther: boolean;
  /** 首次编辑时抢锁:已 editing 直接 true;成功 true 并置 editing;409/无权/失败 false。 */
  beginEdit: () => Promise<boolean>;
}

// 懒获取单写软锁:有编辑权限的人编辑器一打开即可写,聚焦/点正文那一下才真正抢锁;
// 抢不到(他人持活动锁)→ lockedByOther,调用方切回只读。心跳 20s、pagehide/卸载释放。
export function useEditLock(args: { articleId: string | null; canEdit: boolean; autoStart?: boolean }): UseEditLockResult {
  const { articleId, canEdit, autoStart = false } = args;
  const [editing, setEditing] = useState(false);
  const [lockedByOther, setLockedByOther] = useState(false);
  const heartbeat = useRef<number | undefined>(undefined);
  const held = useRef(false);

  const beginEdit = useCallback(async (): Promise<boolean> => {
    if (held.current) return true;
    if (!canEdit || !articleId) return false;
    try {
      await api.articles.acquireEditLock(articleId);
      held.current = true;
      setLockedByOther(false);
      setEditing(true);
      heartbeat.current = window.setInterval(() => {
        void api.articles.acquireEditLock(articleId).catch(() => { /* transient — next tick retries */ });
      }, 20_000);
      return true;
    } catch (err) {
      if (err instanceof EditLockConflictError) {
        setLockedByOther(true); // 切回只读
        toast.error(`正在被 ${err.lock.userName ?? "他人"} 编辑，请稍后`);
      } else if (err instanceof ApiError && err.status === 403) {
        toast.error("无权编辑该文档");
      }
      return false;
    }
  }, [articleId, canEdit]);

  // 新建直达:挂载即尝试进入编辑,光标待命。
  useEffect(() => {
    if (autoStart && canEdit && articleId) void beginEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, canEdit, articleId]);

  // 心跳清理 + 释放锁(pagehide / 卸载)。keepalive 让 DELETE 在页面拆卸后仍发出;
  // 即便丢失,锁也会在 45s TTL 后自动过期。
  useEffect(() => {
    if (!editing || !articleId) return;
    const onPageHide = () => {
      try {
        void fetch(`${API_BASE}/articles/${articleId}/edit-lock`, { method: "DELETE", credentials: "include", keepalive: true });
      } catch { /* 页面离场,无可恢复 */ }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      if (held.current) {
        held.current = false;
        void api.articles.releaseEditLock(articleId).catch(() => { /* idempotent no-op server-side */ });
      }
    };
  }, [editing, articleId]);

  return { editing, lockedByOther, beginEdit };
}
