import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n";

interface ArticleTOCProps {
  markdown: string;
}

interface Heading {
  level: number;
  text: string;
  globalIndex: number;
}

// HTML-decode entities like `&#x20;` (hex space), `&amp;`, `&nbsp;` that
// Milkdown's markdown serializer occasionally emits in heading text
// (e.g. for trailing whitespace or chars that look like markdown
// metacharacters). We use a <textarea>'s innerHTML setter rather than a
// real DOM element: textareas don't parse child tags, so this is safe
// from XSS even if `s` were attacker-controlled.
function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}

// Strip inline-markdown syntax from heading text for the outline. Imported
// docs frequently leave bold/italic/code/link markers inside headings (e.g.
// `## **聊天场景内容卡**`), which the outline would otherwise show literally
// as `**...**`. Only paired markers are removed (so identifiers like `C_API`
// or a lone `*` survive); links/images collapse to their visible text.
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // ![alt](url) / [text](url) → alt/text
    .replace(/\*\*\*([^*]+?)\*\*\*/g, "$1")    // ***bold italic***
    .replace(/\*\*([^*]+?)\*\*/g, "$1")        // **bold**
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")       // *italic*
    .replace(/___([^_]+?)___/g, "$1")          // ___bold italic___
    .replace(/__([^_]+?)__/g, "$1")            // __bold__
    .replace(/~~([^~]+?)~~/g, "$1")            // ~~strike~~
    .replace(/`([^`]+?)`/g, "$1")              // `code`
    .trim();
}

// Parse ATX headings (# ... ###### ...) from a markdown string while
// skipping anything inside fenced code blocks (```...```) — fence
// content can legitimately start a line with `#` (e.g. a Bash comment)
// and must never show up in the document outline.
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  let fenceMarker = "";
  const lines = md.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trimEnd();
    const fenceMatch = line.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0]; // remember "`" vs "~" so we close on the same kind
      } else if (marker[0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      out.push({ level: h[1].length, text: stripInlineMarkdown(decodeHtmlEntities(h[2])), globalIndex: out.length });
    }
  }
  return out;
}

// True when the markdown contains at least one ATX heading. The doc
// pages use this to default the outline rail to collapsed for documents
// that have no outline to show (parseHeadings already skips fenced-code
// `#` lines, so this won't false-positive on a Bash comment).
export function hasHeadings(md: string): boolean {
  return parseHeadings(md).length > 0;
}

// Scroll the nth heading inside .ProseMirror into view. Index is the
// global heading order — the same order parseHeadings produces — so it
// stays in sync with what we render in the TOC. Falls back to no-op if
// the editor hasn't mounted or the heading list got out of sync.
function jumpToHeading(globalIndex: number) {
  const root = document.querySelector(".tm-editor .ProseMirror");
  if (!root) return;
  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  const target = headings[globalIndex];
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  // Briefly highlight the heading so the user sees where they landed.
  target.classList.add("tm-toc-flash");
  window.setTimeout(() => target.classList.remove("tm-toc-flash"), 1200);
}

// Two-glyph outline toggle. Same panel-with-partition base so the
// shape stays recognizable as "the outline rail", but the chevron
// inside flips direction:
//   - open=true  → chevron RIGHT, hinting "fold panel out to the right"
//   - open=false → chevron LEFT,  hinting "pull panel back in from the right"
// Compared to a single icon that just swapped colors, the directional
// chevron makes the action discoverable without reading the tooltip.
export function OutlineToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
      {open ? (
        <polyline points="7 9 10 12 7 15" />
      ) : (
        <polyline points="10 9 7 12 10 15" />
      )}
    </svg>
  );
}

export function ArticleTOC({ markdown }: ArticleTOCProps) {
  const t = useT();
  const headings = useMemo(() => parseHeadings(markdown), [markdown]);

  // Stable observer dep: useMemo returns a new array
  // reference on every markdown change, even when the heading
  // sequence is identical. Hashing the (level,text) pairs lets the
  // effect skip teardown/setup on typical keystrokes — important for
  // long articles where reattaching N IntersectionObservers per
  // character is visibly janky.
  const headingsKey = useMemo(
    () => headings.map((h) => `${h.level}:${h.text}`).join("|"),
    [headings],
  );

  // Track which heading is currently "in view" so we can highlight
  // the matching TOC entry. We use a classic scrollspy (window scroll
  // + rAF throttle, pick the last heading whose top is ≤ threshold)
  // rather than IntersectionObserver — IO with `rootMargin:
  // 0 0 -70% 0` only updates when a heading enters/leaves the top
  // band, so between two headings activeIndex would freeze and the
  // highlight feels disconnected from where the reader actually is.
  // The scrollspy recomputes every scroll frame and always picks the
  // section the reader is currently inside.
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  useEffect(() => {
    if (headings.length === 0) return;
    // y-offset from viewport top at which a heading counts as
    // "passed". 120px clears the workspace header + a bit of buffer.
    const THRESHOLD = 120;
    let raf = 0;
    // Re-query the ProseMirror headings inside compute() rather
    // than once at effect setup. Crepe mounts the editor
    // asynchronously, so on initial render `.ProseMirror` either
    // doesn't exist yet or its headings haven't been parsed —
    // capturing `els` at setup would freeze an empty array forever
    // and the scrollspy would never light up an entry. Re-querying
    // per scroll is cheap (rAF-throttled, a single CSS selector
    // against a known parent) and bulletproofs against any future
    // editor re-mount.
    const compute = () => {
      const root = document.querySelector(".tm-editor .ProseMirror");
      if (!root) { setActiveIndex(-1); return; }
      const els = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
      if (els.length === 0) { setActiveIndex(-1); return; }
      // -1 = nothing highlighted yet (reader is above the first
      // heading). Without this, the first heading would be marked
      // active before the reader has scrolled to it.
      let last = -1;
      for (let i = 0; i < els.length; i++) {
        if (els[i].getBoundingClientRect().top - THRESHOLD > 0) break;
        last = i;
      }
      setActiveIndex(last);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        compute();
        raf = 0;
      });
    };
    // When the article is opened via the slide-in reader
    // (ArticleSlideReader's `flex-1 overflow-y-auto`), scroll events
    // fire on THAT inner container, not on window. Without this
    // attach the highlight would freeze the moment the user starts
    // scrolling the drawer. We still keep the window listener so
    // the standalone /a/:id route (which scrolls the page body)
    // keeps working unchanged. Multiple attaches are dedupe-tracked
    // so the cleanup pass detaches exactly what was added.
    const attached = new Set<HTMLElement>();
    function attachNearestScroller() {
      const root = document.querySelector(".tm-editor .ProseMirror") as HTMLElement | null;
      if (!root) return;
      let el: HTMLElement | null = root.parentElement;
      while (el && el !== document.body) {
        const o = window.getComputedStyle(el).overflowY;
        if ((o === "auto" || o === "scroll") && !attached.has(el)) {
          el.addEventListener("scroll", onScroll, { passive: true });
          attached.add(el);
          // Only the NEAREST one — outer scrollables would re-fire
          // for the same content motion and trigger redundant rAF.
          return;
        }
        el = el.parentElement;
      }
    }
    compute(); // run once for initial active section
    attachNearestScroller(); // editor may already be mounted
    // Editor mounts asynchronously via Crepe — the initial compute()
    // may run before .ProseMirror exists. Retry after 300ms to pick
    // up the headings once the editor has finished mounting (so the
    // outline lights up the right section on landing even before
    // the user scrolls) AND so we can find + attach to the scroller
    // that only exists after Crepe builds the editor DOM.
    const retry = window.setTimeout(() => {
      compute();
      attachNearestScroller();
    }, 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      for (const el of attached) el.removeEventListener("scroll", onScroll);
      window.clearTimeout(retry);
      if (raf) cancelAnimationFrame(raf);
    };
    // `headings` is implicit in `headingsKey` — when the key changes
    // we have a fresh headings array; when the key is stable the
    // current headings are interchangeable with the previous ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingsKey]);

  // Auto-scroll the TOC list so the active entry stays visible as the
  // reader scrolls through the article. We intentionally do NOT use
  // `Element.scrollIntoView()` here: by spec it walks every scrollable
  // ancestor including the window, which on long articles can grab
  // wheel events from the article body and make the page feel like
  // it won't scroll. Instead, find the nearest overflow-y-auto
  // ancestor and adjust ONLY that container's scrollTop — the
  // window's scroll position is never touched.
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const btn = list.children[activeIndex]?.querySelector("button");
    if (!(btn instanceof HTMLElement)) return;
    let container: HTMLElement | null = list.parentElement;
    while (container && container !== document.documentElement) {
      const overflow = getComputedStyle(container).overflowY;
      if (overflow === "auto" || overflow === "scroll") break;
      container = container.parentElement;
    }
    if (!container || container === document.documentElement) return;
    const btnRect = btn.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    if (btnRect.top < cRect.top) {
      container.scrollTop -= cRect.top - btnRect.top + 8;
    } else if (btnRect.bottom > cRect.bottom) {
      container.scrollTop += btnRect.bottom - cRect.bottom + 8;
    }
  }, [activeIndex]);

  if (headings.length === 0) {
    return (
      <div className="text-xs text-muted/60">{t("article.toc.empty")}</div>
    );
  }

  return (
    <nav aria-label={t("article.toc.label")} className="text-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("article.toc.title")}</div>
      <ul ref={listRef} className="flex flex-col gap-0.5">
        {headings.map((h) => (
          <li key={h.globalIndex}>
            <button
              type="button"
              onClick={() => jumpToHeading(h.globalIndex)}
              className={
                "block w-full truncate rounded-lg px-2 py-1 text-left transition " +
                (activeIndex === h.globalIndex
                  ? "bg-accent-soft text-primary font-medium"
                  : "text-muted hover:bg-surface hover:text-primary")
              }
              style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
              title={h.text}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
