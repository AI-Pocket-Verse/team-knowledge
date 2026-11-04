import { useLayoutEffect } from "react";
import { create } from "zustand";

// 右区顶栏左侧的「动态」内容(只有需要面包屑/分享的页才用,比如文档详情)。
// 简单页不用它 —— RightTopBar 会按路由兜底出标题。useLayoutEffect 同步写入 +
// 卸载清空,切页时不闪上一页的内容。
export interface PageChrome {
  /** 纯标题(列表/主页类)。 */
  title?: string;
  /** 面包屑段(文档详情:角色›目录›标题)。优先级高于 title。 */
  breadcrumb?: { label: string; to?: string }[];
  /** 顶栏右侧、图标之前的页面级动作(如文档详情的「分享」)。 */
  rightActions?: React.ReactNode;
}

interface PageChromeState {
  chrome: PageChrome | null;
  set: (c: PageChrome | null) => void;
}

export const usePageChromeStore = create<PageChromeState>((set) => ({
  chrome: null,
  set: (chrome) => set({ chrome }),
}));

// 页面登记自己的顶栏内容;卸载时清空。
//
// 关键:每次渲染都把最新 chrome 推进 store。rightActions 可能是【带内部状态】的
// ReactNode(如文档详情的 ⋯ 菜单,open 由调用方 state 控制)——若只按
// title/breadcrumb 做 key,菜单开合时 effect 不重跑,store 里仍是 open=false 的旧
// 节点,顶栏点了「没反应」。无依赖的 layout effect 保证每次渲染都推送最新节点。
// 只有消费组件自身渲染才会触发(它订阅的是稳定的 set),不会和 RightTopBar 形成环。
export function usePageChrome(chrome: PageChrome): void {
  const set = usePageChromeStore((s) => s.set);
  useLayoutEffect(() => {
    set(chrome);
  });
  // 仅卸载时清空,切页回落到路由兜底(不在每次渲染间清空,避免闪烁)。
  useLayoutEffect(() => () => set(null), [set]);
}
