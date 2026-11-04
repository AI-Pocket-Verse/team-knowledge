import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// 视口内锚定菜单/弹窗的定位:优先在锚点【下方】展开;下方放不下就【翻到上方】;
// 上下都放不下就贴在空间更大的一侧并【限高滚动】。横向按 align 对齐并夹在视口内。
// 基于【实测菜单尺寸】计算(不硬编码条目高度),所以任意条目数都不会被截断。
//
// placeMenu 是纯函数(视口尺寸作为入参),便于单测;useAnchoredMenu 是消费它的
// React 钩子。

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface MenuPlacement {
  top: number;
  left: number;
  /** 仅在上下都放不下时给出:菜单应限高 + 内部滚动。 */
  maxHeight?: number;
}

export function placeMenu(
  anchor: AnchorRect,
  menu: { width: number; height: number },
  viewport: Viewport,
  opts?: { gap?: number; pad?: number; align?: "left" | "right" },
): MenuPlacement {
  const gap = opts?.gap ?? 4; // 锚点与菜单间距
  const pad = opts?.pad ?? 8; // 与视口边缘的最小留白
  const align = opts?.align ?? "left";

  const spaceBelow = viewport.height - anchor.bottom - gap - pad;
  const spaceAbove = anchor.top - gap - pad;

  let top: number;
  let maxHeight: number | undefined;
  if (menu.height <= spaceBelow) {
    top = anchor.bottom + gap; // 下方放得下
  } else if (menu.height <= spaceAbove) {
    top = anchor.top - gap - menu.height; // 翻到上方
  } else if (spaceBelow >= spaceAbove) {
    top = anchor.bottom + gap; // 下方空间更大:贴下沿,限高滚动
    maxHeight = Math.max(80, spaceBelow);
  } else {
    maxHeight = Math.max(80, spaceAbove); // 上方空间更大:顶到上沿,限高滚动
    top = Math.max(pad, anchor.top - gap - maxHeight);
  }

  let left = align === "right" ? anchor.right - menu.width : anchor.left;
  const maxLeft = viewport.width - menu.width - pad;
  left = Math.min(Math.max(pad, left), Math.max(pad, maxLeft));

  return { top, left, maxHeight };
}

/**
 * 把一个 fixed 菜单锚定到 anchorRef。用法:把返回的 menuRef 挂到菜单根节点,
 * 用 placement 设置 top/left/maxHeight,并在 placement 为 null 时隐藏(visibility:
 * hidden)以避免首帧定位前的闪烁。滚动/缩放时自动重算。
 */
export function useAnchoredMenu(
  anchorRef: RefObject<HTMLElement>,
  open: boolean,
  opts?: { align?: "left" | "right" },
): { menuRef: RefObject<HTMLDivElement>; placement: MenuPlacement | null } {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const align = opts?.align ?? "left";

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    function recompute() {
      const a = anchorRef.current;
      const m = menuRef.current;
      if (!a || !m) return;
      const ar = a.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      setPlacement(
        placeMenu(
          { top: ar.top, bottom: ar.bottom, left: ar.left, right: ar.right },
          { width: mr.width, height: mr.height },
          { width: window.innerWidth, height: window.innerHeight },
          { align },
        ),
      );
    }
    recompute();
    // capture:true 捕获祖先(侧边栏)的滚动,菜单跟随锚点重定位。
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, anchorRef, align]);

  return { menuRef, placement };
}
