import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnchoredMenu } from "@/lib/useAnchoredMenu";
import { NavLink, useNavigate, useParams, useLocation } from "react-router-dom";
import type { WorkspaceRole, FolderRow, SlimDoc } from "@team-knowledge/shared";
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  useSensor, useSensors, closestCenter, pointerWithin,
  type CollisionDetection,
  type DragStartEvent, type DragEndEvent, type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy,
  arrayMove, sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable } from "@dnd-kit/core";
import { api } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { cn } from "@/lib/cn";
import { resolveRoleColor } from "@/lib/roleColors";
import { BrandHeader } from "@/components/shell/Brand";
import { ConversationListPanel } from "@/components/workspace/ConversationListPanel";
import { useChatStore } from "@/stores/chat";
import { docHasReviewBadge, folderHasReviewIssues, treeHasReviewIssues, ReviewBadge } from "@/lib/reviewBadge";
import { usePersistedBool } from "@/lib/usePersistedBool";
import { usePersistedNumber } from "@/lib/usePersistedNumber";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { useMeetingBadge } from "@/stores/meetingBadge";
import { useUnsavedGuard } from "@/stores/unsavedGuard";
import {
  AddPopover, useAddActions, RenameDialog, MoveDialog,
  DeleteFolderDialog, DeleteDocDialog,
} from "./RailDialogs";
import { getAssistantName } from "@/lib/assistantName";

// ── Resizable left-rail width (px) ──────────────────────────────────────────
// The EXPANDED rail is draggable between MIN and MAX (default 300). Dragging
// narrower than RAIL_COLLAPSE_AT collapses it to the icon rail instead of
// clamping at MIN (so there's a buffer below MIN you can rest at); dragging the
// collapsed edge back out re-expands. Width is persisted; collapse is separate.
const RAIL_DEFAULT_WIDTH = 300;
const RAIL_MIN_WIDTH = 240;
const RAIL_MAX_WIDTH = 480;
const RAIL_COLLAPSE_AT = RAIL_MIN_WIDTH - 20; // 220
// Cap the rail to a slice of the viewport so it can't crowd out main content
// on a narrow window. Never below MIN.
const railViewportMax = () =>
  Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, Math.floor(window.innerWidth * 0.4)));

// ---- Drag & drop identity helpers ----------------------------------
// dnd-kit ids are strings; we namespace them so one DndContext can host
// three distinct sortable concerns without id collisions:
//   folder:<id>          → a folder, sortable within its role's folder list
//   doc:<id>             → a doc, sortable within its container
//   folderdrop:<id>      → a folder row as a DROP TARGET for docs (move-into)
//   roledrop:<id>        → a role header as a drop target (move doc → role-direct)
// Each sortable also carries `data.current` with { kind, roleId, folderId }
// so onDragEnd resolves the container without re-parsing ids.
type DragKind = "folder" | "doc";
function folderSortId(id: string) { return `folder:${id}`; }
function docSortId(id: string) { return `doc:${id}`; }
function folderDropId(id: string) { return `folderdrop:${id}`; }
function roleDropId(id: string) { return `roledrop:${id}`; }

// Flatten a role tree's folders into the "move document" dialog's target list.
// `depth` (0 = top-level, 1 = subfolder) drives real visual indentation in the
// dialog (rather than baking a full-width space into the name).
export interface MoveTarget { id: string; name: string; depth: number }
function buildMoveTargets(tree: { folders: FolderRow[] }): MoveTarget[] {
  const out: MoveTarget[] = [];
  for (const f of tree.folders) {
    out.push({ id: f.id, name: f.name, depth: 0 });
    for (const c of f.children) out.push({ id: c.id, name: c.name, depth: 1 });
  }
  return out;
}

// Resolve what a FOLDER drag means right now, from the active/over data + rects.
// Returns null when the active drag isn't a folder or there's nothing to do.
//   - nest:    drop on a top-level folder row's MIDDLE → make it that folder's
//              subfolder (only if the dragged folder has no subfolders itself).
//   - promote: drop on the role header → lift a subfolder back to top-level.
//   - reorder: drop on a sibling's TOP/BOTTOM edge → same-parent reorder.
//   - denied:  invalid drop (cross-role, has-children nest, nest under subfolder);
//              `reason` is shown as a toast on drop (omitted = stay silent).
type FolderDragIntent =
  | { kind: "nest"; targetId: string }
  | { kind: "promote" }
  | { kind: "reorder"; parent: string | null }
  | { kind: "denied"; reason?: string };
// Exported for unit testing (the positional band logic can't be exercised
// through jsdom, which has no layout rects).
export function folderDragIntent(e: DragOverEvent | DragEndEvent): FolderDragIntent | null {
  const a = e.active.data.current as
    | { kind?: string; roleId?: string; parentId?: string | null; folderId?: string; hasChildren?: boolean }
    | undefined;
  if (a?.kind !== "folder" || !e.over) return null;
  const overId = String(e.over.id);
  const o = e.over.data.current as
    | { kind?: string; roleId?: string; parentId?: string | null; folderId?: string }
    | undefined;
  // Cross-role is never allowed (silent).
  if (o?.roleId && a.roleId !== o.roleId) return { kind: "denied" };
  // Role header → promote a subfolder to top-level (no-op for an already-top folder).
  if (overId.startsWith("roledrop:")) {
    return (a.parentId ?? null) === null ? null : { kind: "promote" };
  }
  if (overId.startsWith("folder:") || overId.startsWith("folderdrop:")) {
    const targetId = overId.startsWith("folderdrop:")
      ? overId.slice("folderdrop:".length)
      : overId.slice("folder:".length);
    if (targetId === a.folderId) return null; // self
    // Vertical band: middle third = nest, top/bottom edge = reorder. Use the
    // POINTER position (pointerdown clientY + drag delta), NOT the dragged
    // element's center — the latter is offset by wherever in the row the user
    // grabbed it, which would shift the band by up to half a row. onDragOver and
    // onDragEnd both call this with the same pointer math, so highlight and drop
    // stay consistent. Falls back to the dragged-element center, then to edge.
    const oRect = e.over.rect;
    let band: "nest" | "edge" = "edge";
    if (oRect && oRect.height > 0) {
      const ae = e.activatorEvent as { clientY?: number } | undefined;
      const aRect = e.active.rect.current.translated;
      const pointerY =
        ae?.clientY != null ? ae.clientY + e.delta.y
        : aRect ? aRect.top + aRect.height / 2
        : null;
      if (pointerY != null) {
        const rel = (pointerY - oRect.top) / oRect.height;
        band = rel > 0.25 && rel < 0.75 ? "nest" : "edge";
      }
    }
    if (band === "nest") {
      if (a.hasChildren) return { kind: "denied", reason: "含子目录的目录不能移动到别的目录" };
      if ((o?.parentId ?? null) !== null) return { kind: "denied", reason: "不能放进子目录里（最多两级）" };
      if ((a.parentId ?? null) === targetId) return null; // already its child
      return { kind: "nest", targetId };
    }
    // edge → reorder, only within the same parent group.
    if ((a.parentId ?? null) !== (o?.parentId ?? null)) return null;
    return { kind: "reorder", parent: a.parentId ?? null };
  }
  return null;
}

// Collision strategy for the rail's single DndContext.
//
// DOC drags use `pointerWithin` — the droppable the CURSOR is literally inside.
// Each folder's `folderdrop:`/`folder:` rect spans its WHOLE subtree, so under
// closestCenter the nearest droppable center while dragging a doc is almost
// always a sibling `doc:` row or an inner subfolder — the doc could never light
// up (or drop onto) the folder it lives in or, worse, its PARENT folder when a
// subfolder sat between the dragged row and the parent's header. With pointer
// hit-testing, hovering the parent's header strip (which is OUTSIDE the
// subfolder's rect) resolves to the parent reliably, while hovering a subfolder
// or a doc still resolves to the innermost target (dnd-kit returns the deepest
// droppable the pointer is inside first). Falls back to closestCenter when the pointer is in a gap or
// absent (keyboard drag) so a drop is always resolved.
//
// FOLDER drags keep closestCenter + the nest/reorder band logic in
// folderDragIntent — unchanged, to avoid regressing folder reordering.
const railCollisionDetection: CollisionDetection = (args) => {
  if (args.active.data.current?.kind !== "doc") return closestCenter(args);
  const pointerHits = pointerWithin(args);
  return pointerHits.length > 0 ? pointerHits : closestCenter(args);
};

// Folder ids that must be expanded to REVEAL `target` (the doc/folder the URL
// points at) in the rail. Roles auto-expand on load, but folders start collapsed
// (expandedFolders isn't persisted) — so after a refresh a doc nested in a folder,
// or an active subfolder, stays hidden even though it's the routed target. Walks
// each role's tree and returns the ancestor folder-id chain (the containing folder
// plus any parents, root → leaf); [] when the target is role-direct (nothing to
// expand); null when it isn't in the loaded trees yet (the caller retries once the
// fire-and-forget tree fetches arrive). Exported for unit testing.
export function foldersToReveal(
  trees: Record<string, { folders: FolderRow[]; directArticles: SlimDoc[] }>,
  target: { docId?: string; folderId?: string },
): string[] | null {
  const walk = (folders: FolderRow[], path: string[]): string[] | null => {
    for (const f of folders) {
      const here = [...path, f.id];
      if (target.folderId && f.id === target.folderId) return here;
      if (target.docId && f.articles.some((d) => d.id === target.docId)) return here;
      const deeper = walk(f.children, here);
      if (deeper) return deeper;
    }
    return null;
  };
  for (const roleId of Object.keys(trees)) {
    const t = trees[roleId];
    if (target.docId && t.directArticles.some((d) => d.id === target.docId)) return [];
    const hit = walk(t.folders, []);
    if (hit) return hit;
  }
  return null;
}

// Unsaved-changes guard for in-app navigation. Returns an onClick
// handler factory for the rail's <NavLink>s: when the article editor has
// unsaved changes, intercept the click, confirm with the user, and only then
// clear the dirty flag and navigate programmatically. When clean, it's a no-op
// and the NavLink navigates normally. Centralized so every link in the rail
// (quick links, roles, folders, docs) shares identical behavior.
function useGuardedNavClick() {
  const navigate = useNavigate();
  return useCallback(
    (to: string) => (e: React.MouseEvent) => {
      // Only guard plain left-clicks; let modified clicks (new tab/window)
      // through untouched.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
        return;
      }
      if (!useUnsavedGuard.getState().dirty) return;
      // The NavLink default is already prevented; navigation now happens
      // imperatively after the (async) confirm resolves, so swapping the
      // native window.confirm for the project's styled dialog.confirm is
      // safe here — nothing downstream depends on the synchronous return.
      e.preventDefault();
      void dialog
        .confirm("有未保存的修改，确定离开？未保存的内容将丢失。", { confirmText: "离开", danger: true })
        .then((ok) => {
          if (!ok) return;
          useUnsavedGuard.getState().setDirty(false);
          navigate(to);
        });
    },
    [navigate],
  );
}

// Sidebar tree: Role → (Folders → Docs) + Role-direct Docs.
// Pulls per-role tree on-demand; expanded roles fetch + cache.
//
// + button (right of role/folder row): visible when caller has edit
// rights on the parent (role-owned for roles; canEdit for folders).
// Opens AddPopover with Folder / Doc / Import options. Folder rows
// drop the "new folder" option since folders can't nest.
//
// ... button (right of every row): opens RowActionsMenu with
// Rename / Move / Delete. Move only applies to docs (folders can't
// change role).
//
// Active state logic:
//   - Role active when URL is /r/<roleId>
//   - Folder active when URL is /f/<folderId>
//   - Doc active when URL is /d/<docId>
export function WorkspaceLeftRail() {
  const { roleId: roleIdParam, folderId: folderIdParam, docId: docIdParam } =
    useParams<{ roleId?: string; folderId?: string; docId?: string }>();
  const [roles, setRoles] = useState<WorkspaceRole[]>([]);
  const [treesByRole, setTreesByRole] = useState<Record<string, { folders: FolderRow[]; directArticles: SlimDoc[] }>>({});
  const [expandedRoles, setExpandedRoles] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = usePersistedBool("tm.ws.leftRail.collapsed", false);
  const navigate = useNavigate();

  // 左栏模式:文档(知识库树)/ 对话(多任务会话列表)。展开态顶部分段切换。
  const [railMode, setRailMode] = useState<"docs" | "chats">("docs");
  const conversations = useChatStore((s) => s.conversations);
  const conversationsHasMore = useChatStore((s) => s.conversationsHasMore);
  const loadingMoreConversations = useChatStore((s) => s.loadingMoreConversations);
  const activeConversationId = useChatStore((s) => s.conversationId);
  const location = useLocation();
  // 进入会话路由(/c/new、/c/:id)即自动切到「对话」标签 ——助手落地页点发送跳到
  // /c/new 时,左栏随之展示对话列表(满足「发送后跳到对话 tab」)。只单向切到 chats,
  // 不强制切回 docs,用户仍可手动来回。
  useEffect(() => {
    if (location.pathname.startsWith("/c/")) setRailMode("chats");
  }, [location.pathname]);
  // 进入「对话」模式即刷新一次列表(惰性,避免文档用户付出会话请求成本)。
  useEffect(() => {
    if (railMode === "chats") void useChatStore.getState().loadConversations().catch(() => { /* ignore */ });
  }, [railMode]);

  // ── Resizable rail width ─────────────────────────────────────────────────
  // Persisted px width for the expanded rail. Refs mirror the latest values so
  // the window pointer listeners (attached on drag start) read fresh state
  // without re-subscribing on every change.
  const [railWidth, setRailWidth] = usePersistedNumber(
    "tm.ws.leftRail.width", RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH,
  );
  const [dragging, setDragging] = useState(false);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const railWidthRef = useRef(railWidth);
  railWidthRef.current = railWidth;
  // Holds the active drag's cleanup fn so an unmount (or pointercancel) can run
  // it. The drag's window listeners are added imperatively, so React won't tear
  // them down and the body style overrides would otherwise leak.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Start a drag from the right-edge handle. Tracks the pointer on window (so it
  // keeps working past the rail edge), rAF-throttled. Narrower than
  // RAIL_COLLAPSE_AT → collapse; from collapsed, dragging out re-expands.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = collapsedRef.current ? RAIL_MIN_WIDTH : railWidthRef.current;
    setDragging(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    let raf: number | null = null;
    let lastX = startX;
    const apply = () => {
      raf = null;
      const target = startWidth + (lastX - startX);
      if (target < RAIL_COLLAPSE_AT) {
        cleanup();
        setCollapsed(true);
        return;
      }
      if (collapsedRef.current) setCollapsed(false);
      setRailWidth(Math.min(Math.max(target, RAIL_MIN_WIDTH), railViewportMax()));
    };
    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX;
      if (raf == null) raf = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      if (raf != null) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      dragCleanupRef.current = null;
      setDragging(false);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    // pointercancel fires INSTEAD of pointerup when a touch/gesture is hijacked
    // by the system — without it the listeners + body style overrides leak and
    // page-wide text selection stays disabled until the next full drag.
    window.addEventListener("pointercancel", cleanup);
  }, [setCollapsed, setRailWidth]);

  // Double-click the handle → reset to default width (and expand if collapsed).
  const resetRailWidth = useCallback(() => {
    setRailWidth(RAIL_DEFAULT_WIDTH);
    setCollapsed(false);
  }, [setRailWidth, setCollapsed]);

  // Keep the rail within the viewport cap when the window shrinks.
  useEffect(() => {
    const onResize = () => setRailWidth((w) => Math.min(w, railViewportMax()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setRailWidth]);

  // Unmount safety net: if the rail unmounts mid-drag (e.g. navigating to a
  // no-rail page while dragging), run the in-flight cleanup so the drag's window
  // listeners + body style overrides don't leak onto the next page.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const fetchTree = useCallback(async (roleId: string) => {
    try {
      const tree = await api.workspace.tree(roleId);
      setTreesByRole((prev) => ({ ...prev, [roleId]: tree }));
    } catch { /* swallow — empty tree shows in UI */ }
  }, []);

  // 重取角色列表(个人置顶切换后刷新顺序)。只更新 roles,保留已展开态与已缓存 tree。
  const refreshRoles = useCallback(async () => {
    try { const { roles: rs } = await api.workspace.listRoles(); setRoles(rs); }
    catch { /* ignore — 保持现有列表 */ }
  }, []);

  // Initial role list. Auto-expand every role so the tree is fully
  // visible at first paint (the user can collapse what they don't
  // care about; collapse state survives within the session).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { roles: rs } = await api.workspace.listRoles();
        if (cancelled) return;
        setRoles(rs);
        setExpandedRoles((prev) => {
          const next = { ...prev };
          for (const r of rs) if (!(r.id in next)) next[r.id] = true;
          return next;
        });
        // Fire-and-forget tree fetch for each role; the rail renders
        // empty until each tree comes in.
        for (const r of rs) void fetchTree(r.id);
      } catch { /* ignore — rail just shows empty */ }
    })();
    return () => { cancelled = true; };
  }, [fetchTree]);

  // External refresh signal — a sibling page (e.g. the meeting summary
  // "保存到知识库" panel) saved a doc into a role outside the rail's own
  // dialogs. Refetch that role's subtree and auto-expand it so the new
  // draft surfaces immediately, mirroring the AddPopover behavior.
  const treeNonce = useWorkspaceTree((s) => s.nonce);
  const treeRoleId = useWorkspaceTree((s) => s.roleId);
  // Same signal in reverse: after the rail persists a reorder/move, ping it so
  // the routed right-side views (RolePage / ArticleTimeFeed) re-fetch and show
  // the new order immediately instead of going stale until a manual refresh.
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);
  useEffect(() => {
    if (!treeRoleId) return;
    void fetchTree(treeRoleId);
    setExpandedRoles((m) => ({ ...m, [treeRoleId]: true }));
    // treeRoleId is intentionally read from the nonce-gated signal; the
    // nonce in deps is what makes a repeat refresh of the same role fire.
  }, [treeNonce, treeRoleId, fetchTree]);

  // Reveal the active doc / subfolder after a refresh by expanding its ancestor
  // folder chain. Roles auto-expand above, but folders default to collapsed, so a
  // doc inside a folder (or a nested subfolder) would otherwise stay hidden even
  // though the URL points right at it. Trees load fire-and-forget, so this re-runs
  // as treesByRole fills in and acts on the first run that can locate the target.
  // Guarded once per target id (revealedRef) so manually collapsing a folder
  // afterwards isn't fought when the tree later refetches (reorder/move/refresh).
  const revealedRef = useRef<string | null>(null);
  useEffect(() => {
    const target = docIdParam ? { docId: docIdParam } : folderIdParam ? { folderId: folderIdParam } : null;
    if (!target) return;
    const key = docIdParam ? `d:${docIdParam}` : `f:${folderIdParam}`;
    if (revealedRef.current === key) return; // already revealed this target
    const chain = foldersToReveal(treesByRole, target);
    if (chain === null) return; // not in the loaded trees yet — retry when they arrive
    revealedRef.current = key;
    if (chain.length === 0) return; // role-direct — nothing to expand
    setExpandedFolders((m) => {
      let changed = false;
      const next = { ...m };
      for (const id of chain) if (!next[id]) { next[id] = true; changed = true; }
      return changed ? next : m;
    });
  }, [docIdParam, folderIdParam, treesByRole]);

  function toggleRole(rid: string) {
    setExpandedRoles((m) => ({ ...m, [rid]: !m[rid] }));
  }
  function toggleFolder(fid: string) {
    setExpandedFolders((m) => ({ ...m, [fid]: !m[fid] }));
  }

  // ---- Drag & drop --------------------------------------------------
  // PointerSensor with a 5px activation distance: a plain click on a
  // doc/folder NavLink stays a navigation (pointer never travels far
  // enough to "arm" a drag), and only a deliberate drag past 5px starts
  // reordering/moving. This is what keeps click-to-navigate intact.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Label shown in the floating DragOverlay while dragging.
  const [activeDragLabel, setActiveDragLabel] = useState<string | null>(null);
  // True while the drag hovers a drop target in a DIFFERENT role. Cross-role
  // moves aren't supported, so the overlay renders a "禁止拖入" style and the
  // drop is a no-op (see onDragOver / onDragEnd).
  const [dropDenied, setDropDenied] = useState(false);
  // Kind of the row currently being dragged — lets folder rows show the
  // doc-into amber ring ONLY for doc drags (a folder hovering a folder uses
  // the violet nest ring below instead).
  const [activeDragKind, setActiveDragKind] = useState<DragKind | null>(null);
  // Folder id currently highlighted as a "nest into here" target (the dragged
  // folder is over its MIDDLE band and the drop is valid).
  const [folderNestTarget, setFolderNestTarget] = useState<string | null>(null);
  // Folder id a DOC drag is currently hovering (for the amber "move into here"
  // ring). Driven by onDragOver — NOT the folder row's folderdrop `isOver` —
  // because the row's sortable (folder:) usually wins collision detection over
  // its droppable (folderdrop:), so isOver never fires and the ring stayed dark.
  const [docDropFolderTarget, setDocDropFolderTarget] = useState<string | null>(null);

  // Patch a single role's cached tree without a server round-trip
  // (optimistic). Returns BOTH the previous snapshot (so the caller can
  // revert if the server rejects the mutation) and the patched object's
  // identity (so the caller can detect whether a concurrent refetch has
  // since replaced the tree and avoid clobbering that fresher state).
  const patchRoleTree = useCallback(
    (
      roleId: string,
      fn: (t: { folders: FolderRow[]; directArticles: SlimDoc[] }) =>
        { folders: FolderRow[]; directArticles: SlimDoc[] },
    ) => {
      let prev: { folders: FolderRow[]; directArticles: SlimDoc[] } | undefined;
      let patched: { folders: FolderRow[]; directArticles: SlimDoc[] } | undefined;
      setTreesByRole((m) => {
        prev = m[roleId];
        if (!prev) return m;
        patched = fn(prev);
        return { ...m, [roleId]: patched };
      });
      return { prev, patched };
    },
    [],
  );

  // Revert an optimistic patch ONLY if our patched object is still the live
  // tree. If a concurrent refetch (or another optimistic edit) replaced it in
  // the meantime, blindly restoring `prev` would clobber that fresher state —
  // so we leave the current tree alone and re-fetch to reconcile instead.
  const revertRoleTree = useCallback(
    (
      roleId: string,
      prev: { folders: FolderRow[]; directArticles: SlimDoc[] } | undefined,
      patched: { folders: FolderRow[]; directArticles: SlimDoc[] } | undefined,
    ) => {
      if (!prev) return;
      let stillOurs = false;
      setTreesByRole((m) => {
        if (m[roleId] === patched) {
          stillOurs = true;
          return { ...m, [roleId]: prev };
        }
        return m;
      });
      // Our optimistic patch was already superseded — re-fetch so the rail
      // reflects the authoritative server order rather than a stale snapshot.
      if (!stillOurs) void fetchTree(roleId);
    },
    [fetchTree],
  );

  function onDragStart(e: DragStartEvent) {
    setActiveDragLabel((e.active.data.current?.label as string | undefined) ?? null);
    setActiveDragKind((e.active.data.current?.kind as DragKind | undefined) ?? null);
    setDropDenied(false);
    setFolderNestTarget(null);
    setDocDropFolderTarget(null);
  }

  // Update the live drag affordances. For a FOLDER drag, folderDragIntent
  // resolves nest / promote / reorder / denied (incl. the middle-vs-edge band);
  // we light the target row for "nest" and flag denied drops. For a DOC drag we
  // keep the simple cross-role denial (the folder-into amber ring is local).
  function onDragOver(e: DragOverEvent) {
    const intent = folderDragIntent(e);
    if (intent) {
      setFolderNestTarget(intent.kind === "nest" ? intent.targetId : null);
      setDropDenied(intent.kind === "denied");
      setDocDropFolderTarget(null);
      return;
    }
    setFolderNestTarget(null);
    // DOC drag: light the folder under the cursor (top-level OR subfolder).
    // over.id is the folder's sortable (folder:) or droppable (folderdrop:);
    // both carry the folder id. Doc-over-doc (reorder) → over is `doc:` → null.
    const a = e.active.data.current as { kind?: DragKind; roleId?: string } | undefined;
    const o = e.over?.data.current as { roleId?: string; folderId?: string | null } | undefined;
    const overId = e.over ? String(e.over.id) : "";
    // Resolve which FOLDER the doc is hovering so its amber ring lights up even
    // when the cursor is over the folder's CONTENT (a sibling doc) rather than its
    // header row. closestCenter usually surfaces the nearest `doc:` row, so hovering
    // inside the doc's OWN folder or its parent otherwise highlighted nothing —
    // only far-away folders (whose header IS the closest center) lit up. Deriving
    // the folder from the over-doc's folderId fixes the current/parent case.
    const overFolderId =
      overId.startsWith("folderdrop:") ? overId.slice("folderdrop:".length)
      : overId.startsWith("folder:") ? overId.slice("folder:".length)
      : overId.startsWith("doc:") ? (o?.folderId ?? null) // sibling doc → its container folder
      : null;
    setDocDropFolderTarget(a?.kind === "doc" ? overFolderId : null);
    setDropDenied(!!a?.roleId && !!o?.roleId && a.roleId !== o.roleId);
  }

  // Reparent (nest into a folder) or promote (parentId=null) a folder, then
  // refetch the role's tree so the moved node reconciles across groups. Mirrors
  // moveDoc — a plain mutate+refetch keeps cross-group moves simple and correct.
  async function reparentFolder(roleId: string, folderId: string, parentId: string | null) {
    try {
      await api.folders.update(folderId, { parentId });
      // Auto-expand the destination so the moved folder is visible immediately —
      // nesting into a COLLAPSED folder would otherwise hide it until the user
      // manually expands (mirrors the create-flow auto-expand). Promote
      // (parentId=null) lands at top-level, which is always rendered.
      if (parentId) setExpandedFolders((m) => ({ ...m, [parentId]: true }));
      await fetchTree(roleId);
      requestRoleRefresh(roleId); // live-sync the right-side role view
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移动目录失败");
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveDragLabel(null);
    setActiveDragKind(null);
    setDropDenied(false);
    setFolderNestTarget(null);
    setDocDropFolderTarget(null);
    const { active, over } = e;
    if (!over) return;
    const aData = active.data.current as
      | { kind: DragKind; roleId: string; parentId?: string | null; folderId: string | null }
      | undefined;
    if (!aData) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const oData = over.data.current as
      | { kind?: DragKind; roleId?: string; parentId?: string | null; folderId?: string | null }
      | undefined;

    // Cross-role moves are NOT supported (keeps role/collaborator scope
    // intact). Bail out before any reorder/move — the overlay already
    // showed the「不能跨角色移动」state during the drag.
    if (oData?.roleId && aData.roleId !== oData.roleId) return;

    // --- Folder drag: nest / promote / same-parent reorder ----------
    if (aData.kind === "folder") {
      const intent = folderDragIntent(e);
      if (!intent) return;
      const roleId = aData.roleId;
      const movedId = activeId.slice("folder:".length);
      if (intent.kind === "denied") {
        if (intent.reason) toast.error(intent.reason);
        return;
      }
      if (intent.kind === "nest") { await reparentFolder(roleId, movedId, intent.targetId); return; }
      if (intent.kind === "promote") { await reparentFolder(roleId, movedId, null); return; }
      // intent.kind === "reorder" — same-parent group, optimistic.
      const aParent = intent.parent;
      let nextIds: string[] = [];
      const { prev, patched } = patchRoleTree(roleId, (t) => {
        if (aParent === null) {
          const from = t.folders.findIndex((f) => folderSortId(f.id) === activeId);
          const to = t.folders.findIndex((f) => folderSortId(f.id) === overId);
          if (from < 0 || to < 0) return t;
          const folders = arrayMove(t.folders, from, to);
          nextIds = folders.map((f) => f.id);
          return { ...t, folders };
        }
        // Subfolder group: reorder within the parent's `children`.
        const folders = t.folders.map((f) => {
          if (f.id !== aParent) return f;
          const from = f.children.findIndex((c) => folderSortId(c.id) === activeId);
          const to = f.children.findIndex((c) => folderSortId(c.id) === overId);
          if (from < 0 || to < 0) return f;
          const children = arrayMove(f.children, from, to);
          nextIds = children.map((c) => c.id);
          return { ...f, children };
        });
        return { ...t, folders };
      });
      if (!nextIds.length) return;
      try {
        await api.folders.reorder({ roleId, parentId: aParent, ids: nextIds });
        requestRoleRefresh(roleId); // live-sync the right-side role view
      } catch {
        revertRoleTree(roleId, prev, patched);
        toast.error("目录排序失败，已恢复");
      }
      return;
    }

    // --- Doc drag: reorder within container, or move into a folder ---
    if (aData.kind === "doc") {
      const roleId = aData.roleId;
      // Drop onto a folder → move the doc into that folder. A folder row
      // registers BOTH a `folderdrop:` droppable and a `folder:` sortable
      // over the same rect; closestCenter may surface either id for a doc
      // hovering it, so treat both as "move into this folder".
      if (overId.startsWith("folderdrop:") || overId.startsWith("folder:")) {
        const targetFolderId = overId.startsWith("folderdrop:")
          ? overId.slice("folderdrop:".length)
          : overId.slice("folder:".length);
        if (aData.folderId === targetFolderId) return; // already there
        await moveDoc(roleId, activeId.slice("doc:".length), targetFolderId);
        return;
      }
      // Drop onto the role header DROP TARGET → move to role-direct.
      if (overId.startsWith("roledrop:")) {
        if (aData.folderId === null) return; // already role-direct
        await moveDoc(roleId, activeId.slice("doc:".length), null);
        return;
      }
      // Drop onto another doc → reorder within the SAME container, or move into
      // the over-doc's container when it differs. Releasing over a doc that lives
      // in the parent (or another) folder now moves the doc there instead of
      // silently no-op'ing — matching the amber ring onDragOver lights for that
      // folder. Exact cross-container ordering isn't preserved (server appends).
      if (overId.startsWith("doc:")) {
        if (activeId === overId) return;
        const overFolderId = (oData?.folderId ?? null) as string | null;
        if ((aData.folderId ?? null) === overFolderId) {
          await reorderDocs(roleId, aData.folderId ?? null, activeId, overId);
        } else {
          await moveDoc(roleId, activeId.slice("doc:".length), overFolderId);
        }
        return;
      }
    }
  }

  // Move a doc into a folder (or role-direct when targetFolderId=null),
  // then re-fetch the role's tree so sortOrder/containers reconcile. Shows a
  // success toast: a doc-into-folder move (incl. the doc-over-doc cross-container
  // drop) reparents the doc and isn't optimistic/undoable, so it must not be
  // silent — a one-row overshoot onto another folder's doc would otherwise move
  // it with no feedback.
  async function moveDoc(roleId: string, docId: string, targetFolderId: string | null) {
    try {
      await api.articles.move(docId, targetFolderId);
      await fetchTree(roleId);
      requestRoleRefresh(roleId); // live-sync the right-side role/folder view
      toast.success(targetFolderId ? "已移动到目标目录" : "已移动到角色根目录");
    } catch {
      toast.error("移动文档失败");
    }
  }

  // Optimistically reorder docs within one container, then persist.
  async function reorderDocs(
    roleId: string, folderId: string | null, activeDocSortId: string, overDocSortId: string,
  ) {
    let nextIds: string[] = [];
    const { prev, patched } = patchRoleTree(roleId, (t) => {
      const reorderList = (list: SlimDoc[]): SlimDoc[] => {
        const from = list.findIndex((d) => docSortId(d.id) === activeDocSortId);
        const to = list.findIndex((d) => docSortId(d.id) === overDocSortId);
        if (from < 0 || to < 0) return list;
        const moved = arrayMove(list, from, to);
        nextIds = moved.map((d) => d.id);
        return moved;
      };
      if (folderId === null) {
        return { ...t, directArticles: reorderList(t.directArticles) };
      }
      return {
        ...t,
        folders: t.folders.map((f) =>
          f.id === folderId ? { ...f, articles: reorderList(f.articles) } : f,
        ),
      };
    });
    if (!nextIds.length) return;
    try {
      await api.articles.reorder({ roleId, folderId, ids: nextIds });
      requestRoleRefresh(roleId); // live-sync the right-side role/folder view
    } catch {
      revertRoleTree(roleId, prev, patched);
      toast.error("文档排序失败，已恢复");
    }
  }

  // Active-meeting indicator — slow poll (90s) for the red dot on
  // the "助手会议" quick link. Moved here from WorkspaceShell
  // when 会议 moved into the left rail per UX feedback.
  const [hasActiveMeeting, setHasActiveMeeting] = useState(false);
  // Bumped by MeetingRoomPage when a meeting is stopped / hard-deleted (and by
  // MeetingCreatePage when one starts). A change re-runs this effect, which
  // re-checks immediately instead of leaving the dot stale until the 90s poll.
  const meetingBadgeNonce = useMeetingBadge((s) => s.nonce);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.meeting.hasActive();
        if (alive) setHasActiveMeeting(r.hasActive);
      } catch { /* nav badge is best-effort; silent on auth/network */ }
    };
    void tick();
    const id = window.setInterval(tick, 90_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [meetingBadgeNonce]);

  return (
    <div className="relative shrink-0">
      <aside
        className={cn(
          // Rail right edge pulled 10px left of the previous baseline
          // (260→250 / 56→46). Padding is symmetric on both sides
          // (px-2 = 8px) so the search box and the per-row links read
          // the same distance to the rail's left edge and to the right
          // border — previously pl-2/pr-5 made the right gutter 12px
          // wider than the left.
          //
          // h-full (not min-h-): WorkspaceShell wraps us in a flex row
          // of fixed height (h-screen). Bounded height is what lets the
          // middle region below scroll INTERNALLY — brand + top quick
          // links and bottom collapse toggle stay pinned in view.
          "flex h-full flex-col border-r border-line bg-surface",
          // Expanded width is driven by the inline `style` below (resizable);
          // collapsed is the fixed icon rail. No width transition WHILE dragging
          // (must track the cursor 1:1) — collapse/expand + reset still animate.
          collapsed ? "w-[46px] px-2 pt-2 pb-2" : "px-2 pt-3 pb-2",
          !dragging && "transition-[width] duration-150",
        )}
        style={collapsed ? undefined : { width: railWidth }}
        // Disable the browser's native right-click menu across the whole rail.
        // Rows (role / folder / doc) open their own context menu via onContextMenu;
        // blank rail areas just get the native menu suppressed.
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* 品牌头 + 收起切换:展开态 = [logo + 标题] …… [收起按钮(标题行最右)];
            收起态 = 仅展开按钮(居中)。顶部不加横线。负 margin 要与 aside 的 pt 对应
            (展开 pt-3 / 收起 pt-2),否则切换时品牌竖直跳一下。 */}
        <div className={`-mx-2 mb-1 flex h-16 items-center ${collapsed ? "-mt-2 justify-center" : "-mt-3 px-2"}`}>
          {!collapsed && <BrandHeader compact />}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-pressed={collapsed}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
            className={`group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-blue-50/60 hover:text-primary ${collapsed ? "" : "ml-auto"}`}
          >
            <RailToggleIcon collapsed={collapsed} />
            {collapsed && <CollapsedTooltip label="展开侧边栏" />}
          </button>
        </div>
        {/* assistant +助手会议:两种模式(文档/对话)都常驻在最上。 */}
        <div className="flex shrink-0 flex-col gap-0.5">
          <QuickLink to="/" label={getAssistantName()} Icon={BotIcon} collapsed={collapsed} />
          <QuickLink to="/meeting" label="会议" Icon={MeetingIcon} collapsed={collapsed} badge={hasActiveMeeting} />
          <QuickLink to="/automation" label="自动化" Icon={AutomationIcon} collapsed={collapsed} />
          {/* 收起态用一条细线把主导航与下面的角色图标分开;展开态由下面的「文档/对话」切换条自然分隔,不再需要线。 */}
          {collapsed && <div className="mx-1 my-2 border-t border-line" />}
        </div>
        {/* 文档 / 对话 分段切换(放在助手会议 下面;仅展开态)。对话模式复用本栏展示多任务会话列表。
            mt-[14px]:与助手会议再多留 10px 间距(原 mt-1=4px)。 */}
        {!collapsed && (
          <div className="mx-1 mb-2 mt-[14px] flex rounded-lg bg-line/40 p-0.5 text-xs">
            {(["docs", "chats"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setRailMode(m)}
                className={`flex-1 rounded-md py-1.5 font-medium transition ${railMode === m ? "bg-white text-fg shadow-sm" : "text-muted"}`}
              >
                {m === "docs" ? "文档" : "对话"}
              </button>
            ))}
          </div>
        )}
        {/* ── 对话模式:多任务会话列表 ── */}
        {!collapsed && railMode === "chats" ? (
          <ConversationListPanel
            items={conversations}
            activeId={activeConversationId}
            hasMore={conversationsHasMore}
            loadingMore={loadingMoreConversations}
            onLoadMore={() => void useChatStore.getState().loadMoreConversations()}
            onNew={() => { useChatStore.getState().newConversation(); navigate("/c/new"); }}
            // 乐观切换:先切 store(右侧立即换成目标会话)再改 URL,不等路由 effect 重渲染
            //(否则会出现「点一次没切、点两次才刷新」)。HomeChatRoute 随后只做确认 / 兜底。
            onPick={(id) => { void useChatStore.getState().switchConversation(id); navigate(`/c/${id}`); }}
            onRename={(id, t) => void api.chat.renameConversation(id, t).then(() => useChatStore.getState().loadConversations())}
            onPin={(id, pinned) => void api.chat.pinConversation(id, pinned).then(() => useChatStore.getState().loadConversations())}
            onDelete={(id) => void api.chat.deleteConversation(id).then(() => {
              useChatStore.getState().forgetConversation(id); // 清掉该会话的专家记忆/生成中标记,免孤儿残留
              useChatStore.getState().loadConversations();
              // 删的是当前会话 → 回到新对话空态。
              if (useChatStore.getState().conversationId === id) { useChatStore.getState().newConversation(); navigate("/c/new"); }
            })}
          />
        ) : (
        // 文档模式:知识库角色树。只让这块 nav 滚动(下面 nav 的 min-h-0 是关键,
        // 否则 flex 子项不肯收缩、整栏被内容撑高而失去内部滚动)。整棵树在一个 DndContext 内,
        // 单个 onDragEnd 统一处理目录/文档排序与文档移动。
        <DndContext
          sensors={sensors}
          collisionDetection={railCollisionDetection}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => { setActiveDragLabel(null); setActiveDragKind(null); setDropDenied(false); setFolderNestTarget(null); }}
        >
          <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {roles.length === 0 && !collapsed && (
              <div className="px-3 py-1 text-sm text-muted">暂无可见角色</div>
            )}
            {roles.map((r) => {
              const tree = treesByRole[r.id];
              return (
                <RoleNode
                  key={r.id}
                  role={r}
                  tree={tree}
                  isExpanded={!!expandedRoles[r.id]}
                  expandedFolders={expandedFolders}
                  onToggleRole={() => toggleRole(r.id)}
                  onToggleFolder={toggleFolder}
                  // 新建/重命名/删除/导入(文档与目录)统一走全局刷新信号:
                  // 本组件订阅 nonce 后会 fetchTree 该角色(左栏更新),右侧的
                  // RolePage / ArticleListPage 子目录条 / ArticleTimeFeed 文档流
                  // 监听同一 nonce 同步刷新。此前这里只 fetchTree 左栏自己,
                  // 右侧要手动刷浏览器才更新。
                  onTreeChanged={() => requestRoleRefresh(r.id)}
                  onPinToggled={refreshRoles}
                  activeRoleId={roleIdParam}
                  activeFolderId={folderIdParam}
                  activeDocId={docIdParam}
                  activeDragKind={activeDragKind}
                  nestTargetId={folderNestTarget}
                  docTargetId={docDropFolderTarget}
                  collapsed={collapsed}
                />
              );
            })}
          </nav>
          {/* Floating ghost that follows the cursor mid-drag so the user
              sees what they're moving even when the source row dims. */}
          <DragOverlay dropAnimation={null}>
            {activeDragLabel ? (
              dropDenied ? (
                // Cross-role drag — show ONLY「不能拖动」, nothing else.
                <div className="pointer-events-none cursor-not-allowed rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm text-rose-600 shadow-glassLg">
                  不能拖动
                </div>
              ) : (
                <div className="pointer-events-none flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-fg/90 shadow-glassLg">
                  <span className="truncate max-w-[180px]">{activeDragLabel}</span>
                </div>
              )
            ) : null}
          </DragOverlay>
        </DndContext>
        )}

      </aside>
      {/* Right-edge resize handle — straddles the border (3px each side).
          Drag to resize; drag narrower than RAIL_COLLAPSE_AT to collapse;
          double-click to reset to the default width. Kept visible while
          collapsed so it can be dragged back out. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧边栏宽度，双击复位为默认宽度"
        title="拖动调整宽度 · 双击复位"
        onPointerDown={startResize}
        onDoubleClick={resetRailWidth}
        style={{ right: -3, touchAction: "none" }}
        className={cn(
          "absolute top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors",
          dragging ? "bg-primary/50" : "hover:bg-primary/30",
        )}
      />
    </div>
  );
}

function QuickLink({
  to, label, Icon, collapsed, badge,
}: {
  to: string;
  label: string;
  Icon: React.ComponentType<{ filled?: boolean }>;
  collapsed: boolean;
  /** Pulsing red dot on the icon (or top-right when collapsed) —
   *  used by助手会议 to signal "a meeting is active right now." */
  badge?: boolean;
}) {
  // Hover state lives in React because the SVG icons take a `filled`
  // boolean — CSS can swap colors via :hover, but it can't flip a JSX
  // prop. Tracking hover lets the icon mirror its active appearance
  // (violet + filled silhouette) on mouse-over, matching the row's
  // text-color shift so icon and label change together.
  const [hovered, setHovered] = useState(false);
  const guardedNavClick = useGuardedNavClick();
  // Collapsed rail: icon-only, so the dot rides the icon's top-right
  // corner (absolute is the only sensible anchor with no text to sit
  // beside). Expanded rail: the dot becomes an inline flex sibling
  // immediately right of the label and vertically centered with it
  // (self-center), not pinned to the row's corner.
  const CornerDot = (
    <span
      aria-label="正在进行的会议"
      title="正在进行的会议"
      className="absolute right-1 top-1 inline-block h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white animate-pulse"
    />
  );
  const InlineDot = (
    <span
      aria-label="正在进行的会议"
      title="正在进行的会议"
      className="ml-1.5 inline-block h-2 w-2 shrink-0 self-center rounded-full bg-rose-500 ring-2 ring-white animate-pulse"
    />
  );
  return (
    <NavLink
      to={to}
      end
      title={collapsed ? label : undefined}
      onClick={guardedNavClick(to)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-2.5 rounded-md transition truncate",
          collapsed ? "justify-center py-2" : "px-3 py-2 text-sm",
          isActive
            ? "bg-accent-soft text-primary font-semibold"
            : "text-fg/85 hover:bg-blue-50/60 hover:text-primary hover:font-semibold",
        )
      }
    >
      {({ isActive }) => {
        // `lit` = "show the icon's active appearance". Active row OR
        // hover both light the icon up; idle row stays muted/outline.
        const lit = isActive || hovered;
        return collapsed ? (
          <>
            <span className={cn("flex h-7 w-7 items-center justify-center rounded-md transition-colors", lit ? "text-primary" : "text-muted")}>
              <Icon filled={lit} />
            </span>
            {badge && CornerDot}
            <CollapsedTooltip label={label} />
          </>
        ) : (
          <>
            <span className={cn("shrink-0 transition-colors", lit ? "text-primary" : "text-muted")}><Icon filled={lit} /></span>
            <span className="min-w-0 truncate">{label}</span>
            {badge && InlineDot}
          </>
        );
      }}
    </NavLink>
  );
}

// Small floating label that pops up to the right of a collapsed-rail
// icon on hover. Native `title` attributes still ship as a fallback,
// but those have a ~700ms OS-level delay; the custom tooltip surfaces
// the icon's name immediately so the rail stays scannable when the
// reader has icons-only mode on.
// 侧栏「收起 / 展开」图标(仿飞书云文档左上角):一块面板 + 左侧分栏竖线 + 箭头。
// collapsed 时箭头指向内(展开);展开时箭头指向分栏线(收起)。
function RailToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      {collapsed ? <polyline points="13 9 16 12 13 15" /> : <polyline points="16 9 13 12 16 15" />}
    </svg>
  );
}

function CollapsedTooltip({ label }: { label: string }) {
  return (
    <span
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-fg/90 px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity duration-75 group-hover:opacity-100 [will-change:opacity]"
      role="tooltip"
    >
      {label}
    </span>
  );
}

interface RoleNodeProps {
  role: WorkspaceRole;
  tree?: { folders: FolderRow[]; directArticles: SlimDoc[] };
  isExpanded: boolean;
  expandedFolders: Record<string, boolean>;
  onToggleRole: () => void;
  onToggleFolder: (folderId: string) => void;
  onTreeChanged: () => void;
  /** 个人置顶切换后:重取角色列表刷新顺序。 */
  onPinToggled: () => void;
  activeRoleId?: string;
  activeFolderId?: string;
  activeDocId?: string;
  /** Kind of row being dragged right now (gates the doc-into amber ring). */
  activeDragKind?: DragKind | null;
  /** Folder id currently highlighted as a nest target. */
  nestTargetId?: string | null;
  /** Folder id a DOC drag is hovering (amber move-into ring). */
  docTargetId?: string | null;
  collapsed: boolean;
}

function RoleNode({
  role, tree, isExpanded, expandedFolders, onToggleRole, onToggleFolder,
  onTreeChanged, onPinToggled, activeRoleId, activeFolderId, activeDocId, activeDragKind, nestTargetId, docTargetId, collapsed,
}: RoleNodeProps) {
  const { from } = resolveRoleColor(role.color);
  const canManage = role.ownership === "owned";
  const isActiveRole = role.id === activeRoleId;
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const guardedNavClick = useGuardedNavClick();
  // Flattened "move document" targets (top-level + subfolders), built once per
  // tree rather than inline per row.
  const moveTargets = useMemo(() => (tree ? buildMoveTargets(tree) : []), [tree]);

  // Role header is a drop target so a doc dragged onto it moves to
  // role-direct (out of any folder). Only meaningful when the user can
  // manage this role; non-managers get an inert ref. Declared BEFORE
  // the collapsed early-return so hook order stays stable when the rail
  // collapse state toggles.
  const { setNodeRef: setRoleDropRef, isOver: isRoleDropOver } = useDroppable({
    id: roleDropId(role.id),
    data: { kind: "role" as const, roleId: role.id },
    disabled: !canManage || collapsed,
  });

  // Add actions (新建目录/文档/导入) shared by the + popover and right-click menu.
  const { items: addItems, dialogs: addDialogs } = useAddActions(
    { kind: "role", roleId: role.id },
    () => { onTreeChanged(); if (!isExpanded) onToggleRole(); },
  );
  // Right-click context-menu anchor (viewport point), null = closed.
  const [ctxAt, setCtxAt] = useState<{ x: number; y: number } | null>(null);
  const closeCtx = useCallback(() => setCtxAt(null), []);
  // 个人置顶切换(每人各自;任意可见角色皆可,不需管理权)。切完重取列表刷新顺序。
  const togglePin = useCallback(async () => {
    try { await api.workspace.pinRole(role.id, !role.pinned); onPinToggled(); }
    catch { toast.error("操作失败,请重试"); }
  }, [role.id, role.pinned, onPinToggled]);

  if (collapsed) {
    return (
      <NavLink
        to={`/r/${role.id}`}
        end
        title={role.name}
        onClick={guardedNavClick(`/r/${role.id}`)}
        className={({ isActive }) =>
          cn(
            "group relative flex items-center justify-center rounded-md py-2 transition",
            isActive || isActiveRole ? "bg-accent-soft" : "hover:bg-blue-50/60",
          )
        }
      >
        <FolderIcon color={from} />
        {tree && treeHasReviewIssues(tree) && (
          <span title="该角色下有待优化文档" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-surface" />
        )}
        <CollapsedTooltip label={role.name} />
      </NavLink>
    );
  }

  return (
    <div>
      <div
        className="relative group"
        ref={canManage ? setRoleDropRef : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // 所有角色都能右键(至少能个人置顶);新建等管理项仅 canManage 时出现。
          setCtxAt({ x: e.clientX, y: e.clientY });
        }}
      >
        <NavLink
          to={`/r/${role.id}`}
          end
          onClick={guardedNavClick(`/r/${role.id}`)}
          className={({ isActive }) =>
            cn(
              // pr-[64px] leaves room for the two right-side buttons
              // (+ and chevron, each 24px wide with 4px gaps). Roles
              // don't get a ... menu — rename/delete go through admin.
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition truncate pr-[64px]",
              isActive || isActiveRole
                ? "bg-accent-soft text-primary font-semibold"
                : "text-fg/90 hover:bg-blue-50/60 hover:text-primary hover:font-semibold",
              // Highlight the header when a doc hovers it for a
              // move-to-role-direct drop.
              isRoleDropOver && "ring-2 ring-inset ring-primary",
            )
          }
        >
          <FolderIcon color={from} />
          <span className="min-w-0 max-w-full truncate">{role.name}</span>
          {role.pinned && <RolePinnedMark />}
          {tree && treeHasReviewIssues(tree) && <ReviewBadge title="该角色下有待优化文档" />}
        </NavLink>
        {/* Right-side button cluster: + (if can manage) → chevron */}
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {canManage && (
            <button
              ref={addBtnRef}
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAddOpen((v) => !v); }}
              aria-label="新建"
              title="新建目录 / 文档 / 导入"
              className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition group-hover:opacity-100 hover:bg-blue-100 hover:text-primary"
            >
              <PlusIcon />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleRole(); }}
            aria-label={isExpanded ? "收起" : "展开"}
            aria-expanded={isExpanded}
            className="flex h-6 w-6 items-center justify-center rounded text-muted transition hover:bg-blue-100 hover:text-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={cn("transition-transform", isExpanded && "rotate-90")}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
        <AddPopover
          anchorRef={addBtnRef as React.RefObject<HTMLElement>}
          open={addOpen}
          items={addItems}
          onClose={() => setAddOpen(false)}
        />
        {addDialogs}
        {ctxAt && (
          <FloatingActionMenu
            items={[
              { label: role.pinned ? "取消置顶" : "置顶", onClick: () => void togglePin() },
              ...(canManage ? addItems.map((it) => ({ label: it.title, onClick: it.run })) : []),
            ]}
            at={ctxAt}
            onClose={closeCtx}
          />
        )}
      </div>

      {isExpanded && tree && (
        <div className="mt-0.5 flex flex-col gap-0.5 pl-[30px]">
          {tree.folders.length === 0 && tree.directArticles.length === 0 && (
            <div className="px-3 py-1 text-sm text-muted">暂无目录或文档</div>
          )}
          {/* Folder reorder is gated on role-level manage rights; the
              SortableContext still wraps the list either way so the ids
              line up, but each FolderNodeRow only attaches drag listeners
              when canManage. */}
          <SortableContext
            items={tree.folders.map((f) => folderSortId(f.id))}
            strategy={verticalListSortingStrategy}
          >
            {tree.folders.map((f) => (
              <FolderNodeRow
                key={f.id}
                folder={f}
                depth={0}
                moveTargets={moveTargets}
                roleCanManage={canManage}
                isExpanded={!!expandedFolders[f.id]}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onToggle={() => onToggleFolder(f.id)}
                onTreeChanged={onTreeChanged}
                activeFolderId={activeFolderId}
                activeDocId={activeDocId}
                activeDragKind={activeDragKind}
                nestTargetId={nestTargetId}
                docTargetId={docTargetId}
              />
            ))}
          </SortableContext>
          {/* Role-direct docs form their own sortable container. */}
          <SortableContext
            items={tree.directArticles.map((d) => docSortId(d.id))}
            strategy={verticalListSortingStrategy}
          >
            {tree.directArticles.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                folders={moveTargets}
                onTreeChanged={onTreeChanged}
                isActive={d.id === activeDocId}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

function FolderNodeRow({
  folder, depth, moveTargets, roleCanManage, isExpanded, expandedFolders, onToggleFolder,
  onToggle, onTreeChanged, activeFolderId, activeDocId, activeDragKind, nestTargetId, docTargetId,
}: {
  folder: FolderRow;
  /** 0 = top-level folder (renders subfolders + docs); 1 = subfolder (docs only). */
  depth: 0 | 1;
  /** Flattened folder list (top-level + subfolders) for the doc "move" dialog. */
  moveTargets: MoveTarget[];
  /** Role-level manage rights — gates folder REORDER drag. */
  roleCanManage: boolean;
  isExpanded: boolean;
  expandedFolders: Record<string, boolean>;
  onToggleFolder: (folderId: string) => void;
  onToggle: () => void;
  onTreeChanged: () => void;
  activeFolderId?: string;
  activeDocId?: string;
  activeDragKind?: DragKind | null;
  nestTargetId?: string | null;
  docTargetId?: string | null;
}) {
  const canManage = folder.permissions.canEdit;
  const isNestTarget = !!nestTargetId && folder.id === nestTargetId;
  const isActive = folder.id === activeFolderId;
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const guardedNavClick = useGuardedNavClick();
  // Add actions (新建子目录/文档/导入) shared by the + popover and right-click menu.
  const { items: addItems, dialogs: addDialogs } = useAddActions(
    { kind: "folder", roleId: folder.roleId, folderId: folder.id, depth },
    () => { onTreeChanged(); if (!isExpanded) onToggle(); },
  );
  const [ctxAt, setCtxAt] = useState<{ x: number; y: number } | null>(null);
  const closeCtx = useCallback(() => setCtxAt(null), []);

  // Sortable: this folder reorders among its role's folder siblings.
  // Only armed when the role can be managed; otherwise listeners are
  // absent and the row behaves exactly as before.
  const {
    attributes, listeners, setNodeRef: setSortRef, setActivatorNodeRef,
    transform, transition, isDragging,
  } = useSortable({
    id: folderSortId(folder.id),
    data: { kind: "folder" as const, roleId: folder.roleId, parentId: folder.parentId, folderId: folder.id, hasChildren: folder.children.length > 0, label: folder.name },
    disabled: !roleCanManage,
  });
  // Droppable: this folder is a target for docs being moved INTO it.
  const { setNodeRef: setDropRef, isOver: isDocOver } = useDroppable({
    id: folderDropId(folder.id),
    data: { kind: "folder" as const, roleId: folder.roleId, parentId: folder.parentId, folderId: folder.id },
  });
  // One DOM node is both sortable handle source and drop target.
  const setRowRef = (el: HTMLElement | null) => { setSortRef(el); setDropRef(el); };
  // Amber move-into ring: this folder is under a hovering DOC. `docTargetId`
  // (from onDragOver) is the reliable source; isDocOver is a fallback for the
  // rare case the droppable wins collision detection over the sortable.
  const isDocDropTarget = activeDragKind === "doc" && (folder.id === docTargetId || isDocOver);
  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  // The drag activator (dnd-kit `listeners`) is attached to the NavLink below,
  // NOT the row wrapper. The +/.../chevron controls, the add-popover, and every
  // dialog are siblings of that link — so a pointerdown on them can't arm a drag
  // that then gets stranded when the click opens a modal (the modal swallows the
  // pointerup, so onDragEnd never fires → overlay stuck, rail frozen).
  return (
    <div ref={setRowRef} style={dragStyle}>
      <div
        className={cn(
          "relative group rounded-md",
          // Doc-into affordance: amber ring while a DOC hovers this folder
          // (top-level OR subfolder), driven by onDragOver (see isDocDropTarget).
          isDocDropTarget && "ring-2 ring-inset ring-amber-400 bg-amber-50/60",
          // Folder-nest affordance: primary-blue ring while a folder is dropped
          // onto this row's middle band (becomes its subfolder).
          isNestTarget && "ring-2 ring-inset ring-primary bg-blue-50/60",
        )}
        {...(roleCanManage ? attributes : {})}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canManage) setCtxAt({ x: e.clientX, y: e.clientY });
        }}
      >
        <NavLink
          to={`/f/${folder.id}`}
          end
          ref={roleCanManage ? setActivatorNodeRef : undefined}
          {...(roleCanManage ? listeners : {})}
          onClick={guardedNavClick(`/f/${folder.id}`)}
          className={({ isActive: navActive }) =>
            cn(
              "relative flex items-center gap-2.5 rounded-md py-2 pl-3 pr-[70px] text-sm truncate transition",
              roleCanManage && "cursor-grab active:cursor-grabbing",
              navActive || isActive
                ? "bg-accent-soft text-primary font-semibold"
                : "text-fg/85 hover:bg-blue-50/60 hover:text-primary hover:font-semibold",
            )
          }
        >
          <FolderSmallIcon />
          <span className="min-w-0 max-w-full truncate">{folder.name}</span>
          {folderHasReviewIssues(folder) && <ReviewBadge title="该目录下有待优化文档" />}
        </NavLink>
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {canManage && (
            <button
              ref={addBtnRef}
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAddOpen((v) => !v); }}
              aria-label="新建"
              title={depth === 0 ? "在此目录新建子目录 / 文档 / 导入" : "在此目录新建文档 / 导入"}
              className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition group-hover:opacity-100 hover:bg-blue-100 hover:text-primary"
            >
              <PlusIcon />
            </button>
          )}
          {canManage && (
            <RowActionsButton
              actions={[
                { label: "重命名", onClick: () => setRenameOpen(true) },
                { label: "删除", onClick: () => setDeleteOpen(true), danger: true },
              ]}
            />
          )}
          {(folder.children.length > 0 || folder.articles.length > 0) && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
              aria-label={isExpanded ? "收起" : "展开"}
              className="flex h-6 w-6 items-center justify-center rounded text-muted transition hover:bg-blue-100 hover:text-primary"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={cn("transition-transform", isExpanded && "rotate-90")}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
        </div>
        <AddPopover
          anchorRef={addBtnRef as React.RefObject<HTMLElement>}
          open={addOpen}
          items={addItems}
          onClose={() => setAddOpen(false)}
        />
        <RenameDialog
          open={renameOpen}
          kind="folder"
          id={folder.id}
          initialName={folder.name}
          onOpenChange={setRenameOpen}
          onRenamed={onTreeChanged}
        />
        <DeleteFolderDialog
          open={deleteOpen}
          folderId={folder.id}
          folderName={folder.name}
          articleCount={folder.articles.length + folder.children.reduce((n, c) => n + c.articles.length, 0)}
          subfolderCount={folder.children.length}
          onOpenChange={setDeleteOpen}
          onDeleted={onTreeChanged}
        />
        {addDialogs}
        {ctxAt && (
          <FloatingActionMenu
            items={[
              ...addItems.map((it) => ({ label: it.title, onClick: it.run })),
              null,
              { label: "重命名", onClick: () => setRenameOpen(true) },
              { label: "删除", onClick: () => setDeleteOpen(true), danger: true },
            ]}
            at={ctxAt}
            onClose={closeCtx}
          />
        )}
      </div>

      {isExpanded && (folder.children.length > 0 || folder.articles.length > 0) && (
        <div className="mt-0.5 flex flex-col gap-0.5 pl-[18px]">
          {/* Subfolders (top-level folders only): their own sortable group,
              keyed off this folder as the parent. Depth is capped at 2, so a
              subfolder (depth 1) never renders further children. */}
          {depth === 0 && folder.children.length > 0 && (
            <SortableContext
              items={folder.children.map((c) => folderSortId(c.id))}
              strategy={verticalListSortingStrategy}
            >
              {folder.children.map((c) => (
                <FolderNodeRow
                  key={c.id}
                  folder={c}
                  depth={1}
                  moveTargets={moveTargets}
                  roleCanManage={roleCanManage}
                  isExpanded={!!expandedFolders[c.id]}
                  expandedFolders={expandedFolders}
                  onToggleFolder={onToggleFolder}
                  onToggle={() => onToggleFolder(c.id)}
                  onTreeChanged={onTreeChanged}
                  activeFolderId={activeFolderId}
                  activeDocId={activeDocId}
                  activeDragKind={activeDragKind}
                  nestTargetId={nestTargetId}
                  docTargetId={docTargetId}
                />
              ))}
            </SortableContext>
          )}
          {/* Docs inside this folder form their own sortable container,
              keyed off the folderId so reorder stays scoped to it. */}
          {folder.articles.length > 0 && (
            <SortableContext
              items={folder.articles.map((d) => docSortId(d.id))}
              strategy={verticalListSortingStrategy}
            >
              {folder.articles.map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  folders={moveTargets}
                  onTreeChanged={onTreeChanged}
                  isActive={d.id === activeDocId}
                />
              ))}
            </SortableContext>
          )}
        </div>
      )}
    </div>
  );
}

function DocRow({
  doc, folders, onTreeChanged, isActive,
}: {
  doc: SlimDoc;
  folders: MoveTarget[];
  onTreeChanged: () => void;
  isActive: boolean;
}) {
  const canManage = doc.permissions.canEdit;
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const guardedNavClick = useGuardedNavClick();
  const [ctxAt, setCtxAt] = useState<{ x: number; y: number } | null>(null);
  const closeCtx = useCallback(() => setCtxAt(null), []);

  // Sortable: docs reorder within their container and can be dragged
  // onto a folder/role drop target to move. Drag is gated on canManage
  // (same flag that shows the ... actions). Listeners live on the row
  // wrapper — PointerSensor's 5px activation keeps a plain click on the
  // NavLink a navigation, so only a real drag reorders/moves.
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef,
    transform, transition, isDragging,
  } = useSortable({
    id: docSortId(doc.id),
    data: { kind: "doc" as const, roleId: doc.roleId, folderId: doc.folderId, label: doc.title || "（未命名）" },
    disabled: !canManage,
  });
  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  // Drag activator (dnd-kit `listeners`) lives on the NavLink, not this wrapper —
  // see the folder row for the full rationale. Keeps the "..." menu + its dialogs
  // (siblings of the link) from arming a drag the opening modal would strand.
  return (
    <div
      ref={setNodeRef}
      style={dragStyle}
      className="relative group"
      {...(canManage ? attributes : {})}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (canManage) setCtxAt({ x: e.clientX, y: e.clientY });
      }}
    >
      <NavLink
        to={`/d/${doc.id}`}
        end
        ref={canManage ? setActivatorNodeRef : undefined}
        {...(canManage ? listeners : {})}
        onClick={guardedNavClick(`/d/${doc.id}`)}
        className={({ isActive: navActive }) =>
          cn(
            "relative flex items-center gap-2.5 rounded-md py-2 pl-3 pr-[36px] text-sm truncate transition",
            canManage && "cursor-grab active:cursor-grabbing",
            navActive || isActive
              ? "bg-accent-soft text-primary font-semibold"
              : "text-fg/85 hover:bg-blue-50/60 hover:text-primary hover:font-semibold",
          )
        }
      >
        <DocIcon />
        <span className="min-w-0 max-w-full truncate">{doc.title || "（未命名）"}</span>
        {docHasReviewBadge(doc) && <ReviewBadge title="该文档存在 AI 校验发现的待优化问题" />}
      </NavLink>
      {canManage && (
        <div className="absolute inset-y-0 right-1 flex items-center">
          <RowActionsButton
            actions={[
              { label: "重命名", onClick: () => setRenameOpen(true) },
              { label: "移动", onClick: () => setMoveOpen(true) },
              { label: "删除", onClick: () => setDeleteOpen(true), danger: true },
            ]}
          />
        </div>
      )}
      <RenameDialog
        open={renameOpen}
        kind="doc"
        id={doc.id}
        initialName={doc.title}
        onOpenChange={setRenameOpen}
        onRenamed={onTreeChanged}
      />
      <MoveDialog
        open={moveOpen}
        docId={doc.id}
        roleId={doc.roleId}
        currentFolderId={doc.folderId}
        folders={folders}
        onOpenChange={setMoveOpen}
        onMoved={onTreeChanged}
      />
      <DeleteDocDialog
        open={deleteOpen}
        docId={doc.id}
        docTitle={doc.title || "（未命名）"}
        roleId={doc.roleId}
        folderId={doc.folderId}
        onOpenChange={setDeleteOpen}
        onDeleted={onTreeChanged}
      />
      {ctxAt && (
        <FloatingActionMenu
          items={[
            { label: "重命名", onClick: () => setRenameOpen(true) },
            { label: "移动", onClick: () => setMoveOpen(true) },
            { label: "删除", onClick: () => setDeleteOpen(true), danger: true },
          ]}
          at={ctxAt}
          onClose={closeCtx}
        />
      )}
    </div>
  );
}

interface RowAction {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

// Shared menu row used by BOTH the "..." actions menu and the right-click
// context menu. Centralizes the hover treatment so 重命名/删除/移动 etc. get the
// same text-color shift on hover as every other interactive row in the rail.
function MenuItemButton({ action, onClose }: { action: RowAction; onClose: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={action.disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        action.onClick?.();
      }}
      className={cn(
        "block w-full px-3 py-1.5 text-left text-sm transition",
        action.disabled && "cursor-not-allowed text-muted/60",
        !action.disabled && (action.danger
          ? "text-rose-600 hover:bg-rose-50 hover:text-rose-700"
          : "text-fg/85 hover:bg-surface hover:text-primary"),
      )}
    >
      {action.label}
    </button>
  );
}

// Floating menu opened at a viewport point (cursor) — powers the right-click
// context menu on role / folder / doc rows. `null` entries render a divider.
// Closes on outside-click, Escape, scroll, or resize.
function FloatingActionMenu({
  items, at, onClose,
}: {
  items: (RowAction | null)[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) { if (!menuRef.current?.contains(e.target as Node)) onClose(); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  // Clamp so the menu never spills off-screen near the right/bottom edges.
  const MENU_W = 176;
  const MENU_H = items.length * 34 + 8;
  const left = Math.max(6, Math.min(at.x, window.innerWidth - MENU_W - 6));
  const top = Math.max(6, Math.min(at.y, window.innerHeight - MENU_H - 6));
  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 w-44 rounded-xl border border-line bg-white py-1 shadow-glassLg"
      style={{ top, left }}
    >
      {items.map((it, i) =>
        it === null
          ? <div key={`sep-${i}`} className="my-1 border-t border-line" />
          : <MenuItemButton key={i} action={it} onClose={onClose} />,
      )}
    </div>
  );
}

function RowActionsButton({ actions }: { actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // 视口内锚定 + 实测高度翻转/限高:右对齐按钮;靠近底部自动上翻;条目再多
  // 也按真实高度判断,不会被截断(取代原先硬编码 3 条高度的估算)。
  const { menuRef, placement } = useAnchoredMenu(btnRef, open, { align: "right" });

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, menuRef]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="更多操作"
        title="更多操作"
        className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition group-hover:opacity-100 hover:bg-blue-100 hover:text-primary"
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 w-40 overflow-y-auto rounded-xl border border-line bg-white py-1 shadow-glassLg"
          style={{
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            maxHeight: placement?.maxHeight,
            // 定位算出前先隐藏,避免首帧闪在 (0,0)。
            visibility: placement ? "visible" : "hidden",
          }}
        >
          {actions.map((a, i) => (
            <MenuItemButton key={i} action={a} onClose={() => setOpen(false)} />
          ))}
        </div>
      )}
    </>
  );
}

// ---------- Icons ----------
// Robot-style glyph for the homepage "assistant" quick link — antenna on
// top, square head with two eye dots, and two short ear stubs.
// Sized to 18×18 to match the role FolderIcon so top-level rail entries
// (assistant /助手会议 / each role) read at the same visual weight.
//
// Filled state needs per-shape fill overrides: a blanket
// `fill="currentColor"` would paint the eye circles and the antenna
// ball the same color as the head, swallowing them. We instead fill
// only the head + antenna ball with currentColor, then re-fill the
// eyes with white so they stay visible against the solid head.
function BotIcon({ filled }: { filled?: boolean }) {
  const headFill = filled ? "currentColor" : "none";
  const eyeFill = filled ? "#fff" : "currentColor";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V5" />
      <circle cx="12" cy="3.5" r="1.5" fill={headFill} />
      <rect x="4" y="8" width="16" height="12" rx="2" fill={headFill} />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <circle cx="9" cy="14" r="1.1" fill={eyeFill} stroke="none" />
      <circle cx="15" cy="14" r="1.1" fill={eyeFill} stroke="none" />
    </svg>
  );
}
// Microphone glyph — matches the 🎙️ that lived in the top nav.
// 18×18 to align with BotIcon and FolderIcon (role) for a consistent
// top-level icon weight. The active state only fills the mic capsule;
// filling the half-circle arc would draw a closed disk that doesn't
// look like a mic stand any more.
// 自动化(定时/触发任务)图标:闹钟。filled 时表盘填充以呼应激活态。
function AutomationIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" fill={filled ? "currentColor" : "none"} fillOpacity={filled ? 0.12 : 1} />
      <path d="M12 9v4l2 2" />
      <path d="M5 3 2 6" />
      <path d="m22 6-3-3" />
      <path d="M6.38 18.7 4 21" />
      <path d="M17.64 18.67 20 21" />
    </svg>
  );
}

function MeetingIcon({ filled }: { filled?: boolean }) {
  const capsuleFill = filled ? "currentColor" : "none";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" fill={capsuleFill} />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
// Role-level folder: bigger (18) than sub-rows so the hierarchy reads
// at a glance, and the role's signature color tints both the stroke
// AND the fill (low alpha) — a thin outline alone is too weak to
// "look like a folder" at sidebar scale.
// 角色已个人置顶的小标记(展示在角色名后)。
function RolePinnedMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="已置顶" className="shrink-0 text-primary/70">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function FolderIcon({ color }: { color?: string }) {
  const c = color ?? "currentColor";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={c} fillOpacity="0.18" stroke={c} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
// Sub-folder: amber-tinted classic folder. Bigger (17) than the old
// 14px muted outline + warm fill so it's unmistakably a folder shape
// next to the cool-gray DocIcon below — that color contrast is what
// makes folder-vs-doc scannable at small size.
function FolderSmallIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="#fbbf24" fillOpacity="0.35" stroke="#d97706" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
// Doc: cool slate-tinted page with corner fold + two text lines, so
// the silhouette differs from the folder at a glance — different
// outer shape, different color family, and the interior lines push
// "this is a document, not a container" even further.
function DocIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#e2e8f0" fillOpacity="0.7" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
