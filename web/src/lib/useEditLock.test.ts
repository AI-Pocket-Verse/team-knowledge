import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      articles: {
        acquireEditLock: vi.fn(),
        releaseEditLock: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});
vi.mock("@/components/Toaster", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useEditLock } from "./useEditLock";
import { api, EditLockConflictError } from "@/lib/api";

beforeEach(() => vi.clearAllMocks());

describe("useEditLock", () => {
  it("canEdit=false → beginEdit 不抢锁、返回 false", async () => {
    const { result } = renderHook(() => useEditLock({ articleId: "a1", canEdit: false }));
    let ok!: boolean;
    await act(async () => { ok = await result.current.beginEdit(); });
    expect(ok).toBe(false);
    expect(api.articles.acquireEditLock).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
  });

  it("抢锁成功 → editing=true", async () => {
    (api.articles.acquireEditLock as ReturnType<typeof vi.fn>).mockResolvedValue({ lock: { mine: true } });
    const { result } = renderHook(() => useEditLock({ articleId: "a1", canEdit: true }));
    await act(async () => { await result.current.beginEdit(); });
    expect(api.articles.acquireEditLock).toHaveBeenCalledWith("a1");
    expect(result.current.editing).toBe(true);
  });

  it("抢锁 409 → editing 保持 false,返回 false", async () => {
    (api.articles.acquireEditLock as ReturnType<typeof vi.fn>).mockRejectedValue(
      new EditLockConflictError("被占用", { userId: "u2", userName: "张三", mine: false }),
    );
    const { result } = renderHook(() => useEditLock({ articleId: "a1", canEdit: true }));
    let ok!: boolean;
    await act(async () => { ok = await result.current.beginEdit(); });
    expect(ok).toBe(false);
    expect(result.current.editing).toBe(false);
  });
});
