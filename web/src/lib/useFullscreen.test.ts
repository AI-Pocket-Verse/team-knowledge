import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFullscreen, __resetFullscreenScopeForTest } from "./useFullscreen";

const pressEsc = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

describe("useFullscreen", () => {
  beforeEach(() => { __resetFullscreenScopeForTest(); });

  it("默认非全屏,toggle 进入/退出", () => {
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.isFullscreen).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.isFullscreen).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isFullscreen).toBe(false);
  });

  it("同 scope 跨挂载延续:详情页全屏 → 卸载 → 编辑页(同文档)初始即全屏", () => {
    const detail = renderHook(() => useFullscreen("d:1"));
    act(() => detail.result.current.toggle());
    expect(detail.result.current.isFullscreen).toBe(true);
    detail.unmount(); // 路由切换,详情页卸载

    const edit = renderHook(() => useFullscreen("d:1"));
    expect(edit.result.current.isFullscreen).toBe(true); // 点「编辑」进来不退全屏
  });

  it("不同 scope 不继承:另一篇文档打开仍是非全屏", () => {
    const a = renderHook(() => useFullscreen("d:1"));
    act(() => a.result.current.toggle());
    a.unmount();

    const b = renderHook(() => useFullscreen("d:2"));
    expect(b.result.current.isFullscreen).toBe(false);
  });

  it("退出全屏(toggle)清掉会话:同 scope 重新挂载不再全屏", () => {
    const a = renderHook(() => useFullscreen("d:1"));
    act(() => a.result.current.toggle());
    act(() => a.result.current.toggle()); // 退出
    a.unmount();

    const b = renderHook(() => useFullscreen("d:1"));
    expect(b.result.current.isFullscreen).toBe(false);
  });

  it("Esc 退出并清掉会话", () => {
    const a = renderHook(() => useFullscreen("d:1"));
    act(() => a.result.current.toggle());
    pressEsc();
    expect(a.result.current.isFullscreen).toBe(false);
    a.unmount();

    const b = renderHook(() => useFullscreen("d:1"));
    expect(b.result.current.isFullscreen).toBe(false);
  });

  it("无 scope(如 create 模式)退化为页面局部状态,不跨挂载", () => {
    const a = renderHook(() => useFullscreen());
    act(() => a.result.current.toggle());
    a.unmount();

    const b = renderHook(() => useFullscreen());
    expect(b.result.current.isFullscreen).toBe(false);
  });

  it("挂载期间换 scope(同组件跳到另一篇)全屏会话跟过去", () => {
    const hook = renderHook(({ scope }: { scope: string }) => useFullscreen(scope), {
      initialProps: { scope: "d:1" },
    });
    act(() => hook.result.current.toggle());
    hook.rerender({ scope: "d:2" }); // 详情页内点链接跳到另一篇,组件不卸载
    expect(hook.result.current.isFullscreen).toBe(true);
    hook.unmount();

    // 会话标记已跟到 d:2 —— 它的编辑页接得上,d:1 不再全屏。
    expect(renderHook(() => useFullscreen("d:2")).result.current.isFullscreen).toBe(true);
  });
});
