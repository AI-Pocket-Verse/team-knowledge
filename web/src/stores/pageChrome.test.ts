import { createElement } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, renderHook } from "@testing-library/react";
import { usePageChrome, usePageChromeStore } from "./pageChrome";

describe("pageChrome", () => {
  beforeEach(() => usePageChromeStore.setState({ chrome: null }));

  it("usePageChrome 挂载写入、卸载清空", () => {
    const { unmount } = renderHook(() => usePageChrome({ title: "文档" }));
    expect(usePageChromeStore.getState().chrome?.title).toBe("文档");
    unmount();
    expect(usePageChromeStore.getState().chrome).toBeNull();
  });

  it("后挂载覆盖先挂载(切页)", () => {
    const a = renderHook(() => usePageChrome({ title: "A" }));
    const b = renderHook(() => usePageChrome({ title: "B" }));
    expect(usePageChromeStore.getState().chrome?.title).toBe("B");
    b.unmount();
    a.unmount();
  });

  // 回归:rightActions 是带内部状态的节点(如 ⋯ 菜单开合)时,重渲染必须把最新
  // 节点推进 store —— 否则顶栏点了「没反应」。title 不变也要更新。
  it("重渲染推送最新 rightActions(即使 title 不变)", () => {
    function Probe({ n }: { n: number }) {
      usePageChrome({ title: "x", rightActions: createElement("span", null, n) });
      return null;
    }
    const { rerender } = render(createElement(Probe, { n: 1 }));
    const first = usePageChromeStore.getState().chrome?.rightActions as { props: { children: number } };
    expect(first.props.children).toBe(1);
    rerender(createElement(Probe, { n: 2 }));
    const second = usePageChromeStore.getState().chrome?.rightActions as { props: { children: number } };
    expect(second.props.children).toBe(2);
  });
});
