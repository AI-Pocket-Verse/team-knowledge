import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoleSkillSummaryItem } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

export type ChatMentionType = "doc" | "folder" | "skill";

export interface ChatMentionItem {
  type: ChatMentionType;
  id: string;
  label: string;
  // Sub-label rendered in muted under the main label. For docs it's
  // "<role> / <folder>"; for folders "<role>"; for skills the status /
  // "未生成,无法选择" when disabled.
  hint?: string;
  // Skills with no generated content render greyed + unselectable.
  disabled?: boolean;
}

interface Props {
  query: string;
  // Caret position in viewport coords. We need BOTH edges so the
  // popover can flip above the caret when there's no room below
  // (e.g. composer at the bottom of the screen). `caretTop` /
  // `caretBottom` are the top/bottom of the line the caret is on.
  anchor: { left: number; caretTop: number; caretBottom: number };
  onSelect: (item: ChatMentionItem) => void;
  onClose: () => void;
}

// Pixel gap kept between the popover and the caret + between the
// popover and the viewport edges when we have to clamp.
const VIEWPORT_MARGIN = 8;
const CARET_GAP = 4;

// 每个 tab 最多渲染 5 行;但 tab 上的数字徽标显示「全部可选数」(非这个 5 的上限)。
const DISPLAY_LIMIT = 5;
// 文档浏览态(无搜索)从最近 feed 取的计数上限:取到 50 用于徽标计数,只展示前 5。
const DOC_FETCH_CAP = 50;

// Tiny cache with a 60s TTL: workspace roles + per-role trees + skill
// availability are roughly static during a chat session but DO get stale
// (an admin adds a folder/role, or a skill finishes generating). A
// 60-second freshness window covers the common case (fast popover reopens
// after picking the previous mention) without locking users out of newly
// created entities for the whole session.
interface RoleEntry { id: string; name: string }
interface FolderEntry { id: string; name: string; roleName: string; updatedAt: string }
const CACHE_TTL_MS = 60_000;
let cachedRoles: RoleEntry[] | null = null;
let cachedFolders: FolderEntry[] | null = null;
let cachedSkills: RoleSkillSummaryItem[] | null = null;
let cacheLoadedAt = 0;
let cacheInflight: Promise<void> | null = null;

function cacheIsFresh(): boolean {
  return cachedRoles !== null && cachedFolders !== null && cachedSkills !== null
    && (Date.now() - cacheLoadedAt) < CACHE_TTL_MS;
}

async function loadWorkspaceCache(): Promise<void> {
  if (cacheIsFresh()) return;
  if (cacheInflight) return cacheInflight;
  cacheInflight = (async () => {
    try {
      // Roles drive the folder trees; the skill summary drives the Skills
      // tab. Fetch in parallel — a skill-summary failure just yields an
      // empty Skills tab, it shouldn't break docs/folders.
      const [{ roles }, skillSummary] = await Promise.all([
        api.workspace.listRoles(),
        api.roleSkill.summary().catch(() => ({ skills: [] as RoleSkillSummaryItem[] })),
      ]);
      const nextRoles: RoleEntry[] = roles.map((r) => ({ id: r.id, name: r.name }));
      // Fan out per-role tree fetches in parallel. If any one fails
      // (e.g. permission flipped server-side mid-session), we just
      // skip that role's folders — the rest of the popover still
      // works.
      const trees = await Promise.all(
        roles.map(async (r) => {
          try {
            const t = await api.workspace.tree(r.id);
            return { role: r, folders: t.folders };
          } catch {
            return { role: r, folders: [] as Array<{ id: string; name: string; updatedAt: string }> };
          }
        }),
      );
      const nextFolders: FolderEntry[] = trees.flatMap(({ role, folders }) =>
        folders.map((f) => ({ id: f.id, name: f.name, roleName: role.name, updatedAt: f.updatedAt })),
      );
      cachedRoles = nextRoles;
      cachedFolders = nextFolders;
      cachedSkills = skillSummary.skills;
      cacheLoadedAt = Date.now();
    } catch {
      // Keep whatever cached snapshot we had (might be stale-but-useful);
      // otherwise fall back to empty so the popover still renders
      // its empty state instead of getting stuck "loading…".
      cachedRoles = cachedRoles ?? [];
      cachedFolders = cachedFolders ?? [];
      cachedSkills = cachedSkills ?? [];
    } finally {
      cacheInflight = null;
    }
  })();
  return cacheInflight;
}

// Move `from` to the next non-disabled index in `dir` (+1/-1), wrapping.
// Returns `from` when every row is disabled (or the list is empty).
function stepEnabled(list: ChatMentionItem[], from: number, dir: 1 | -1): number {
  const n = list.length;
  if (n === 0) return 0;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (!list[i]?.disabled) return i;
  }
  return from;
}

function firstEnabled(list: ChatMentionItem[]): number {
  const i = list.findIndex((it) => !it.disabled);
  return i >= 0 ? i : 0;
}

export function ChatMentionPopover({ query, anchor, onSelect, onClose }: Props) {
  const [docs, setDocs] = useState<ChatMentionItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  // 弹窗内置搜索框:以触发时 @ 后面的文字做种子,之后由搜索框驱动过滤(文档/目录/Skills)。
  // 焦点移到搜索框 → 编辑器不再接收输入 → query prop 不再变,搜索框成为唯一过滤源。
  const [search, setSearch] = useState(query);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Kick the workspace cache once on first mount; bump a render tick
  // when it lands so the folders/skills sections appear without the
  // user having to type another character.
  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceCache().then(() => {
      if (!cancelled) forceTick((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, []);

  // Doc data flow:
  //   - query === ""  → BROWSE mode: pull the user's most recent
  //                     accessible feed via /api/me/feed. Lets the user
  //                     pick a doc by scanning without having to type.
  //   - query !== ""  → SEARCH mode: /api/articles/search by title,
  //                     debounced 200ms to avoid hammering on each
  //                     keystroke. Citation-permission filtered.
  // The folder/skill sections already render their full list on empty
  // query (client-side cache filter); without browse mode the docs
  // section would silently stay empty and feel like "docs not supported".
  useEffect(() => {
    let cancelled = false;
    setDocs([]);
    setDocsError(null);
    setDocsLoading(true);
    // Browse mode runs immediately (cheap server hit, no debounce);
    // search mode waits 200ms so we don't fire on every keystroke.
    const delay = search.length === 0 ? 0 : 200;
    const fmtHint = (roleName: string, folderName: string | null) =>
      folderName ? `${roleName} / ${folderName}` : roleName;
    const timer = setTimeout(() => {
      // 取「全部」(浏览态取最近 DOC_FETCH_CAP 条,搜索态取全部命中)用于徽标计数;
      // 展示时只渲染前 DISPLAY_LIMIT 条(见 currentList)。
      const fetcher: Promise<ChatMentionItem[]> =
        search.length === 0
          ? api.feed({ take: DOC_FETCH_CAP }).then((r) =>
              r.articles.map((a) => ({
                type: "doc" as const,
                id: a.id,
                label: a.title,
                hint: fmtHint(a.roleName, a.folderName),
              })),
            )
          : api.articles.search(search).then((r) =>
              r.hits.map((h) => ({
                type: "doc" as const,
                id: h.id,
                label: h.title,
                hint: fmtHint(h.roleName, h.folderName),
              })),
            );
      fetcher
        .then((items) => {
          if (cancelled) return;
          setDocs(items);
          setDocsError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setDocs([]);
          setDocsError((err as Error).message || "搜索失败");
        })
        .finally(() => {
          if (!cancelled) setDocsLoading(false);
        });
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search]);

  // Folders + skills are client-side filtered against the cached
  // workspace snapshot. Empty query → show the first N of each so the
  // user can browse without typing.
  const folders: ChatMentionItem[] = useMemo(() => {
    const all = cachedFolders ?? [];
    const q = search.toLowerCase();
    // 浏览态(空搜索):按 updatedAt 倒序取最近更新的 N 条;搜索态:按名过滤。
    // updatedAt 是 ISO 串,字典序与时间序一致,可直接比较。
    const match = q.length === 0
      ? [...all].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      : all.filter((f) => f.name.toLowerCase().includes(q));
    // 返回「全部匹配」(用于徽标计数);展示截断到 DISPLAY_LIMIT 在 currentList 做。
    return match.map((f) => ({
      type: "folder" as const,
      id: f.id,
      label: f.name,
      hint: f.roleName,
    }));
  // cachedFolders is a module-level value; we depend on `search` + the
  // forced re-render tick (via cachedFolders being mutated after fetch)
  // to recompute.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, cachedFolders]);

  // Each role's AI skill. Roles whose skill hasn't been generated render
  // greyed-out + unselectable with a "未生成" hint.
  const skills: ChatMentionItem[] = useMemo(() => {
    const all = cachedSkills ?? [];
    const q = search.toLowerCase();
    // Skills 无 updatedAt(每角色一项),浏览态按 summary 原序取前 N 条。
    const match = q.length === 0
      ? all
      : all.filter((s) => s.roleName.toLowerCase().includes(q));
    return match.map((s) => ({
      type: "skill" as const,
      id: s.roleId,
      label: s.roleName,
      hint: s.usable ? "技能就绪" : "未生成,无法选择",
      disabled: !s.usable,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, cachedSkills]);

  // Tab state. Each `@` open lands on the 文档 tab by default —
  // that's the most-common pick. `active` is the row index INSIDE
  // the current tab's list (not a flat-list index).
  const [activeTab, setActiveTab] = useState<ChatMentionType>("doc");
  // 当前 tab 的「全部匹配」(用于徽标计数);展示只渲染前 DISPLAY_LIMIT 条。
  const currentFull = useMemo<ChatMentionItem[]>(() => {
    if (activeTab === "doc") return docs;
    if (activeTab === "folder") return folders;
    return skills;
  }, [activeTab, docs, folders, skills]);
  const currentList = useMemo<ChatMentionItem[]>(() => currentFull.slice(0, DISPLAY_LIMIT), [currentFull]);

  // Keep the highlight on an ENABLED row: reset to the first selectable row
  // when the tab switches or the list changes (and the current row dropped
  // out / is disabled). Without this a disabled skill row could look selected.
  useEffect(() => {
    setActive((i) => (currentList[i] && !currentList[i]!.disabled ? i : firstEnabled(currentList)));
  }, [currentList, activeTab]);

  // Default position: just above the caret. The composer sits at the
  // bottom of every chat surface (HomeChatPanel & AiBubble), so the
  // caret is typically near the viewport bottom — placing the popover
  // BELOW would clip the list. We prefer ABOVE for consistency and
  // only fall back to BELOW when there genuinely isn't room above.
  // useLayoutEffect runs after the DOM is laid out but before the
  // browser paints, so the first frame already shows the corrected
  // position without flicker.
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.left,
    // Cheap initial estimate: caret minus the inner list cap (~292px).
    // The measure-and-correct below replaces this within the same
    // paint frame.
    top: Math.max(VIEWPORT_MARGIN, anchor.caretTop - 292 - CARET_GAP),
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Vertical: PREFER ABOVE the caret. If the popover would clip
    // the top of the viewport, fall back to BELOW; if even that
    // doesn't fit (rare — popover taller than viewport), clamp to
    // the bottom safe area.
    let top = anchor.caretTop - h - CARET_GAP;
    if (top < VIEWPORT_MARGIN) {
      top = Math.min(vh - h - VIEWPORT_MARGIN, anchor.caretBottom + CARET_GAP);
      if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;
    }
    // Horizontal: keep right edge inside viewport.
    let left = anchor.left;
    if (left + w + VIEWPORT_MARGIN > vw) {
      left = Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN);
    }
    setPos({ left, top });
  }, [anchor.left, anchor.caretTop, anchor.caretBottom, activeTab, currentList.length, docsLoading, docsError]);

  // Keep the active row inside the visible scroll region. Each tab
  // body is a separate scroll container; the [aria-selected=true]
  // row lives in whichever tab is active.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const row = root.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [active, activeTab]);

  // Keyboard nav. We mount on document so the keys work while the
  // contentEditable host has focus (popover itself isn't focused —
  // mousedown anywhere outside closes it via onOutside below).
  //
  // Key bindings:
  //   - ArrowLeft / ArrowRight: cycle tabs (doc → folder → skill → doc)
  //   - ArrowUp / ArrowDown:    move highlight within current tab (skips disabled)
  //   - Enter:                  pick the highlighted (enabled) row
  //   - Escape / Tab:           close popover
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // 焦点在搜索框时,左右键用于移动文字光标,不切 tab。
        if (document.activeElement === inputRef.current) return;
        e.preventDefault();
        const order: ChatMentionType[] = ["doc", "folder", "skill"];
        const idx = order.indexOf(activeTab);
        const next = e.key === "ArrowRight"
          ? order[(idx + 1) % order.length]
          : order[(idx - 1 + order.length) % order.length];
        setActiveTab(next);
        return;
      }
      if (currentList.length === 0) {
        if (e.key === "Enter") {
          // Empty list: don't swallow Enter — let it submit the
          // composer like normal. Just close the popover so the user's
          // un-resolved `@xyz` text stays as plain characters.
          onClose();
        }
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => stepEnabled(currentList, i, 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive((i) => stepEnabled(currentList, i, -1)); }
      if (e.key === "Enter") {
        const item = currentList[active];
        if (item && !item.disabled) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(item);
        } else {
          // Highlighted row is disabled (un-generated skill) / none selectable
          // → don't select; close so Enter submits the composer normally.
          onClose();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [activeTab, currentList, active, onSelect, onClose]);

  // Click outside closes.
  useEffect(() => {
    function onOutside(e: MouseEvent | TouchEvent) {
      const node = ref.current;
      if (node && !node.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [onClose]);

  // Inline label for each tab — kept short so 3 buttons fit in the
  // 288–384px popover width without wrapping.
  const TAB_META: Record<ChatMentionType, { label: string; icon: string }> = {
    doc:    { label: "文档", icon: "📄" },
    folder: { label: "目录", icon: "📁" },
    skill:  { label: "Skills", icon: "🧩" },
  };
  const counts: Record<ChatMentionType, number> = {
    doc: docs.length,
    folder: folders.length,
    skill: skills.length,
  };

  // Per-tab body: docs has its own loading / error placeholder
  // because it's the only async-fetched tab. Folders / skills fall
  // back to a generic empty message since they're filtered locally
  // from a cache that always resolves.
  function renderTabBody() {
    if (currentList.length > 0) {
      return currentList.map((it, i) => (
        <MentionRow
          key={`${it.type}:${it.id}`}
          item={it}
          active={i === active}
          onClick={() => { if (!it.disabled) onSelect(it); }}
        />
      ));
    }
    if (activeTab === "doc") {
      return (
        <div className={cn(
          "px-3 py-4 text-sm",
          docsError ? "text-rose-600" : "text-muted",
        )}>
          {docsLoading ? "搜索中…" : docsError ? `搜索失败：${docsError}` : "无匹配文档"}
        </div>
      );
    }
    return (
      <div className="px-3 py-4 text-sm text-muted">
        {activeTab === "folder" ? "无匹配目录" : "暂无角色技能"}
      </div>
    );
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="选择引用对象"
      // flex flex-col: tab strip stays pinned at top while the body
      // scrolls. max-w-96 caps width on desktop; min-w-72 keeps it
      // readable on tight viewports.
      className="fixed z-50 flex flex-col min-w-72 max-w-96 rounded-xl border border-line bg-white shadow-glassLg"
      style={{ left: pos.left, top: pos.top }}
    >
      {/* 内置搜索框:过滤当前(及各)tab 的文档/目录/Skills。自动聚焦,左右键在框内移动光标。 */}
      <div className="shrink-0 border-b border-line p-1.5">
        <input
          ref={inputRef}
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 文档 / 目录 / Skills…"
          className="w-full rounded-lg border border-line px-2.5 py-1.5 text-xs outline-none focus:border-primary"
        />
      </div>
      <div role="tablist" className="flex shrink-0 border-b border-line">
        {(["doc", "folder", "skill"] as ChatMentionType[]).map((t) => {
          const meta = TAB_META[t];
          const isActive = activeTab === t;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={isActive}
              // mousedown not click — same reason as MentionRow: the
              // contentEditable composer would blur on click and
              // close the popover before the tab switch lands.
              onMouseDown={(e) => { e.preventDefault(); setActiveTab(t); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs transition",
                "border-b-2 -mb-px",
                isActive
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted hover:text-fg",
              )}
            >
              <span aria-hidden>{meta.icon}</span>
              <span>{meta.label}</span>
              {counts[t] > 0 && (
                <span className={cn(
                  "text-[10px]",
                  isActive ? "text-primary/70" : "text-muted/70",
                )}>
                  {counts[t]}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* max-h-72 (288px) + overflow-y-auto: list scrolls inside the
          popover while the tabs stay visible. py-1 gives a small
          breathing border above the first row / below the last. */}
      <div
        role="listbox"
        className="max-h-72 overflow-y-auto py-1"
      >
        {renderTabBody()}
      </div>
    </div>,
    document.body,
  );
}

function MentionRow({
  item, active, onClick,
}: {
  item: ChatMentionItem;
  active: boolean;
  onClick: () => void;
}) {
  const icon = item.type === "doc" ? "📄" : item.type === "folder" ? "📁" : "🧩";
  const disabled = !!item.disabled;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-disabled={disabled}
      // mousedown not click — click fires AFTER blur, which the parent
      // listens to on the contentEditable. mousedown lets us select
      // before the host loses focus / closes the popover. Disabled rows
      // (un-generated skills) preventDefault but don't select.
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
        disabled
          ? "cursor-not-allowed opacity-50"
          : active ? "bg-accent-soft text-primary" : "hover:bg-surface",
      )}
    >
      <span aria-hidden className="shrink-0 text-xs">{icon}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="block truncate font-medium">{item.label}</span>
        {item.hint && (
          <span className={cn("block truncate text-xs", disabled ? "text-muted/70" : "text-muted")}>{item.hint}</span>
        )}
      </span>
    </button>
  );
}
