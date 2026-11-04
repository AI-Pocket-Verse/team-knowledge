import { useEffect, useState } from "react";

// 模块级「全屏会话」标记:全屏状态本是页面局部 state,路由切换(详情 → 编辑)
// 组件卸载就丢了 —— 用户全屏读文档、点「编辑」,啪一下退回非全屏。这里按
// scope(调用方传,如 `d:<docId>`)把全屏意图记在模块变量里,同一篇文档的
// 详情页 ↔ 编辑页互相延续(含保存返回、浏览器后退);换 scope(别的文档)
// 不继承;刷新页面重置 —— 全屏是一次浏览的状态,不是持久偏好。
//
// 前提:同一时刻最多只有一个「带 scope」的实例处于挂载态(当前详情页 /d/:id 与
// 编辑页 /d/:id/edit 是各自独立路由,从不共存)。这个模块级单槽不区分多实例 ——
// 若将来出现两个不同 scope 的实例同屏并同时进全屏,后者会覆盖此槽,前者的跨路由
// 延续会丢。届时需改为按 scope 计数/分槽。
let activeFullscreenScope: string | null = null;

/** 「全屏浏览/编辑」的状态封装 —— CSS 覆盖层方案,不用浏览器原生
 *  Fullscreen API。原生全屏把元素放进 top layer,portal 到 body 的
 *  Dialog(z-[60])/Toaster(z-[70])/抽屉会被盖住不可见不可点;
 *  CSS 方案(容器加 `fixed inset-0 z-40 overflow-y-auto bg-bg p-8`,
 *  见调用方)铺满视口、压住 z-30 的页头,而弹窗/toast 仍在其上,全屏
 *  中一切交互照常。Esc 退出在这里统一监听(尊重 defaultPrevented,
 *  popover 等先吃掉 Esc 时不退出);退出后原页面滚动位置不受影响。
 *
 *  `scope` 可选:传了则全屏状态跨路由延续(见 activeFullscreenScope);
 *  不传退化为纯页面局部状态(如 create 模式没有稳定 id)。 */
export function useFullscreen(scope?: string) {
  const [isFullscreen, setIsFullscreen] = useState(scope != null && activeFullscreenScope === scope);

  const set = (v: boolean) => {
    setIsFullscreen(v);
    if (scope != null) activeFullscreenScope = v ? scope : null;
  };

  // scope 在挂载期间变化(同组件内跳到另一篇文档)时,把全屏会话跟过去,
  // 保持「标记 === 当前 scope」的不变量,后续页面才接得上。
  useEffect(() => {
    if (isFullscreen && scope != null) activeFullscreenScope = scope;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) set(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  return { isFullscreen, toggle: () => set(!isFullscreen) };
}

/** 全屏态容器要附加的类(调用方拼接)。 */
export const FULLSCREEN_CONTAINER_CLASS = "fixed inset-0 z-40 overflow-y-auto bg-bg p-8";

/** 仅供测试:重置模块级全屏会话标记。 */
export function __resetFullscreenScopeForTest(): void {
  activeFullscreenScope = null;
}
