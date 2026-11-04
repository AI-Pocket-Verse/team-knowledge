import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";

export type AutosaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export interface UseAutosaveArgs {
  /** 仅在编辑态启用自动保存(懒锁:未进入编辑不保存)。 */
  enabled: boolean;
  /** 当前编辑内容。 */
  data: { title: string; body: string };
  /** 最近一次成功保存的内容,用于判断 dirty。 */
  baseline: { title: string; body: string };
  /** 持久化函数;409 冲突时应 throw ApiError(status=409)。 */
  save: (d: { title: string; body: string }) => Promise<void>;
  /** 防抖毫秒,默认 1000。 */
  delay?: number;
  /** 成功保存后回调(调用方据此更新 baseline / 版本号)。 */
  onSaved?: (d: { title: string; body: string }) => void;
}

export interface UseAutosaveResult {
  state: AutosaveState;
  lastSavedAt: number | null;
  dirty: boolean;
  /** 立即保存(失焦 / 离开前)。 */
  flush: () => void;
  /** 冲突后强制再存(调用方应先刷新版本号)。 */
  overwrite: () => void;
}

// 防抖自动保存 + 409 冲突处理。冲突时停在 conflict 态(不丢用户编辑),
// 由调用方刷新版本号后 overwrite() 覆盖保存。
export function useAutosave(args: UseAutosaveArgs): UseAutosaveResult {
  const { enabled, data, baseline, save, delay = 1000, onSaved } = args;
  const dirty = data.title !== baseline.title || data.body !== baseline.body;
  const [state, setState] = useState<AutosaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  // refs 保证定时器回调读到最新值,无需重建定时器。
  const dataRef = useRef(data); dataRef.current = data;
  const saveRef = useRef(save); saveRef.current = save;
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const snapshot = dataRef.current;
    setState("saving");
    try {
      await saveRef.current(snapshot);
      setState("saved");
      setLastSavedAt(Date.now());
      onSavedRef.current?.(snapshot);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState("conflict");
      else setState("error");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !dirty || state === "conflict") return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void run(); }, delay);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [enabled, dirty, data.title, data.body, delay, state, run]);

  const flush = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (enabled && dirty) void run();
  }, [enabled, dirty, run]);

  const overwrite = useCallback(() => {
    setState("idle"); // 解除 conflict,允许下面的 effect / 本次再存
    void run();
  }, [run]);

  return { state, lastSavedAt, dirty, flush, overwrite };
}
