import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutosave } from "./useAutosave";
import { ApiError } from "@/lib/api";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useAutosave", () => {
  it("dirty 后防抖触发 save,成功进入 saved", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook((p: Parameters<typeof useAutosave>[0]) => useAutosave(p), {
      initialProps: { enabled: true, baseline: { title: "a", body: "x" }, data: { title: "a", body: "x" }, save, delay: 1000 },
    });
    expect(result.current.dirty).toBe(false);
    rerender({ enabled: true, baseline: { title: "a", body: "x" }, data: { title: "a", body: "y" }, save, delay: 1000 });
    expect(result.current.dirty).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(save).toHaveBeenCalledWith({ title: "a", body: "y" });
    expect(result.current.state).toBe("saved");
  });

  it("save 抛 409 → 进入 conflict,且不丢编辑内容", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError("conflict", 409));
    const { result, rerender } = renderHook((p: Parameters<typeof useAutosave>[0]) => useAutosave(p), {
      initialProps: { enabled: true, baseline: { title: "a", body: "x" }, data: { title: "a", body: "x" }, save, delay: 100 },
    });
    rerender({ enabled: true, baseline: { title: "a", body: "x" }, data: { title: "a", body: "z" }, save, delay: 100 });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(result.current.state).toBe("conflict");
    expect(result.current.dirty).toBe(true); // 编辑仍在
  });

  it("disabled 时不保存", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook((p: Parameters<typeof useAutosave>[0]) => useAutosave(p), {
      initialProps: { enabled: false, baseline: { title: "a", body: "x" }, data: { title: "a", body: "x" }, save, delay: 100 },
    });
    rerender({ enabled: false, baseline: { title: "a", body: "x" }, data: { title: "a", body: "q" }, save, delay: 100 });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(save).not.toHaveBeenCalled();
  });
});
