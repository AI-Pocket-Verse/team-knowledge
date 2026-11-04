import { useEffect, useRef, useState } from "react";

/**
 * Floating "scroll back to top" button for the article reading view.
 * Appears only when the reader has scrolled past 1.5× viewport
 * heights — anything shorter and a return-trip is trivial without
 * the button, so we don't add visual noise.
 *
 * Position: HORIZONTALLY anchored to the article body's right edge
 * (NOT to the viewport's right) so the button visually belongs to
 * the document column instead of floating in the gutter / under
 * the TOC. We measure `.tm-editor .ProseMirror`'s right edge each
 * mount + on layout changes (window resize, TOC toggle, drawer
 * resize) and set the `right` style inline. The Tailwind class
 * `right-6` stays as a fallback for the brief moment before Crepe
 * mounts the editor.
 * Vertical anchor remains `bottom-24` (96px above viewport bottom)
 * so the button still sits comfortably above the AI chat bubble
 * stack on the lower portion of the screen.
 * Idle 50% transparency keeps it as a convenience affordance —
 * visible but not competing with primary actions; hover restores
 * full opacity + brand tint.
 *
 * Scroll source: this view can mount in TWO places:
 *   - standalone /a/:id route → page scrolls the window
 *   - slide-in reader (ArticleSlideReader) → scrolling happens
 *     inside its `flex-1 overflow-y-auto` container, NOT the window
 * To handle both we listen on window AND on the nearest scrollable
 * ancestor of the editor. The drawer case is the one that broke
 * after the slide reader landed — without the inner attach, the
 * button never appeared in the drawer regardless of how far the
 * user scrolled.
 */
export function BackToTopButton() {
  const [visible, setVisible] = useState(false);
  // Distance from viewport right edge — set by measuring the article
  // body's right edge. `null` means "before Crepe mounts" — fall back
  // to the Tailwind `right-6` from the className.
  const [rightOffset, setRightOffset] = useState<number | null>(null);
  // The active inner scroller, if the article is rendered inside an
  // overflow-y-auto drawer. Null when scrolling happens on window.
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const recompute = () => {
      const el = scrollerRef.current;
      // Read scroll metrics from whichever container is actually
      // scrolling. The 1.5× factor stays the same — "past one and a
      // half screens" is the natural threshold for "the trip back
      // is annoying enough that a button helps".
      const passed = el
        ? el.scrollTop > el.clientHeight * 1.5
        : window.scrollY > window.innerHeight * 1.5;
      setVisible(passed);
      raf = 0;
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(recompute);
    };

    function findScrollableAncestor(): HTMLElement | null {
      const root = document.querySelector(".tm-editor .ProseMirror") as HTMLElement | null;
      if (!root) return null;
      let el: HTMLElement | null = root.parentElement;
      while (el && el !== document.body) {
        const o = window.getComputedStyle(el).overflowY;
        if (o === "auto" || o === "scroll") return el;
        el = el.parentElement;
      }
      return null;
    }
    function rebindInner() {
      const next = findScrollableAncestor();
      if (next === scrollerRef.current) return;
      if (scrollerRef.current) {
        scrollerRef.current.removeEventListener("scroll", onScroll);
      }
      scrollerRef.current = next;
      if (next) next.addEventListener("scroll", onScroll, { passive: true });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    rebindInner();   // sync — editor may already be in the DOM
    recompute();
    // Crepe mounts asynchronously, so the inner scroller often isn't
    // discoverable on first render. Retry once after the editor
    // settles so the button reacts to drawer scrolling without
    // requiring the user to scroll the window first.
    const retry = window.setTimeout(() => {
      rebindInner();
      recompute();
    }, 300);

    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollerRef.current) scrollerRef.current.removeEventListener("scroll", onScroll);
      scrollerRef.current = null;
      window.clearTimeout(retry);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  // Align the button's center with the article action bar's center —
  // the user wants them on the same vertical axis (`垂直对齐`). We
  // measure `.tm-article-actionbar`'s rect and set the button's
  // `right` so their horizontal midpoints match. Falls back to the
  // editor's right edge when the action bar isn't mounted (legacy
  // reading surfaces) so the button still positions sensibly.
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let observed: HTMLElement | null = null;
    const BUTTON_WIDTH = 44; // matches `h-11 w-11` below
    const recompute = () => {
      const bar = document.querySelector(".tm-article-actionbar") as HTMLElement | null;
      if (bar) {
        const r = bar.getBoundingClientRect();
        const center = r.left + r.width / 2;
        const rightEdgeX = center + BUTTON_WIDTH / 2;
        setRightOffset(Math.max(4, window.innerWidth - rightEdgeX));
        if (typeof ResizeObserver !== "undefined" && bar !== observed) {
          ro?.disconnect();
          ro = new ResizeObserver(recompute);
          ro.observe(bar);
          observed = bar;
        }
        return;
      }
      // Fallback: align with the article body's right edge.
      const editor = document.querySelector(".tm-editor .ProseMirror") as HTMLElement | null;
      if (!editor) { setRightOffset(null); return; }
      const editorRect = editor.getBoundingClientRect();
      setRightOffset(Math.max(0, window.innerWidth - (editorRect.right + 20)));
    };
    recompute();
    // Crepe mounts asynchronously, so the first sync measurement
    // often misses. Retry once after the editor settles.
    const retry = window.setTimeout(recompute, 300);
    window.addEventListener("resize", recompute);
    return () => {
      window.clearTimeout(retry);
      window.removeEventListener("resize", recompute);
      ro?.disconnect();
    };
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => {
        // Scroll whichever container is the active scroller — the
        // drawer in the slide-reader case, window otherwise.
        const el = scrollerRef.current;
        if (el) el.scrollTo({ top: 0, behavior: "smooth" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      }}
      aria-label="回到顶部"
      title="回到顶部"
      style={rightOffset != null ? { right: `${rightOffset}px` } : undefined}
      className="fixed bottom-24 right-6 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-white/50 text-muted opacity-50 shadow-glassLg backdrop-blur transition hover:bg-white hover:text-primary hover:opacity-100"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  );
}
