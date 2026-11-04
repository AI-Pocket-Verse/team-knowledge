import { useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { useChatStore } from "@/stores/chat";
import { useAiSurface } from "@/stores/aiSurface";
import { ChatComposer } from "./ChatComposer";
import { ChatMessageList } from "./ChatMessageList";
import { streamChat } from "./useChatStream";
import { cn } from "@/lib/cn";
import { getAssistantName } from "@/lib/assistantName";

// Floating AI surface with three states:
//   1. closed  → only the bottom-right bubble is visible
//   2. open + unpinned → centered floating popover (transient feel)
//   3. open + pinned   → full-height right-side docked panel (the
//      workspace shell adds matching right-padding so the main
//      content never sits behind this panel)
//
// "Pin" persists in the chat store. Default is unpinned to keep
// first-time users from losing screen real estate to AI by surprise.
// Drag threshold in pixels — below this the pointer-up is treated
// as a click (open/close panel), above it as a drag (commit new
// position to the store). Without a threshold, every tap would
// register as a 1–2px micro-drag and the panel would never open.
const DRAG_THRESHOLD = 4;
// Diameter of the floating bubble — used to clamp the dragged
// position so the button never lands fully off-screen.
const BUBBLE_SIZE = 48;

export function AiBubble() {
  const isOpen = useChatStore((s) => s.isOpen);
  const isPinned = useChatStore((s) => s.isPinned);
  const setOpen = useChatStore((s) => s.setOpen);
  const setPinned = useChatStore((s) => s.setPinned);
  const bubblePos = useChatStore((s) => s.bubblePos);
  const setBubblePos = useChatStore((s) => s.setBubblePos);
  const messages = useChatStore((s) => s.messages);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const summary = useChatStore((s) => s.summary);
  const summaryUpToMessageId = useChatStore((s) => s.summaryUpToMessageId);
  const isThinking = useChatStore((s) => s.isThinking);
  const hasMoreOlder = useChatStore((s) => s.hasMoreOlder);
  const loadingOlder = useChatStore((s) => s.loadingOlder);

  const hydrated = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [selecting, setSelecting] = useState(false); // 多选分享模式(入口在 composer 分享键)
  // Drag bookkeeping. We mutate refs (not state) during the drag so
  // every pointermove can update DOM directly without triggering a
  // React re-render storm — only the final pointerup commits via
  // setBubblePos.
  const dragState = useRef<
    | { startX: number; startY: number; startLeft: number; startTop: number; moved: boolean }
    | null
  >(null);
  // Set to true on a real drag; the synthesized click that follows
  // pointerup reads this and bails before toggling the panel.
  const justDragged = useRef(false);

  // Detect "I'm reading an article right now" by matching the doc
  // URL pattern. useMatch works anywhere inside the Router, including
  // the floating AI panel mounted at the app shell. When this is
  // non-null the user is on /a/:articleId and we forward the id so
  // the chat route can scope retrieval to that doc.
  const articleMatch = useMatch("/a/:articleId");
  const activeArticleId = articleMatch?.params.articleId ?? null;

  // Suppress this entire surface on the workspace homepage — that route
  // mounts HomeChatPanel inline as the primary chat affordance, and
  // surfacing both the floating bubble and the inline panel would be
  // redundant (they share the same store and would race for the same
  // composer focus). Other routes (article view / role / folder /
  // bookmarks / profile) keep the bubble as before.
  const onHome = useMatch({ path: "/", end: true });
  // 多任务对话深链(/c/new、/c/:id)也由 WorkspaceEntry 内联渲染 HomeChatPanel,
  // 同样要隐藏浮窗气泡,否则两个聊天界面共享同一 store、抢同一个输入框焦点。
  const onChatRoute = useMatch("/c/*");
  // 某些页面自带聊天式内容(如自动化运行详情:运行中/查看运行后),再浮出一个可输入的
  //助手气泡只会造成困惑 —— 由该页登记 suppressed,这里整块隐藏。
  const suppressed = useAiSurface((s) => s.suppressed);

  useEffect(() => {
    if (!isOpen || hydrated.current) return;
    hydrated.current = true;
    void useChatStore.getState().hydrate().catch(() => { /* ignore */ });
  }, [isOpen]);

  // Abort any in-flight stream when the bubble unmounts (e.g. user
  // navigates to the home route where AiBubble returns null). Without
  // this, the SSE keeps streaming server-side and the global chat
  // store keeps mutating behind a UI that no longer exists.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function onSend(content: string, mentions: { type: "doc" | "folder" | "role"; id: string; label: string }[]) {
    const store = useChatStore.getState();
    // 当前会话 id(空=新对话,首发由后端建并在 done 回传)。必须显式传给后端,否则
    // /api/chat/message 每次都会惰性新建一条孤儿会话,而流式消息却渲染进当前显示的会话,
    // 刷新后这些消息就「消失」了(已落在另一条会话里)。
    const cid = store.conversationId ?? undefined;
    store.appendUser(content, mentions);
    // Delay beginAssistant until the first server event lands — see
    // the matching comment in HomeChatPanel.onSend for why.
    let assistantStarted = false;
    function ensureAssistant() {
      if (assistantStarted) return;
      assistantStarted = true;
      useChatStore.getState().beginAssistant();
    }
    const ac = new AbortController();
    abortRef.current = ac;
    let citedIds: string[] = [];
    await streamChat(content, {
      signal: ac.signal,
      conversationId: cid,
      articleId: activeArticleId,
      // Forward just {type, id} — server resolves labels from DB.
      mentions: mentions.map(({ type, id }) => ({ type, id })),
      onCited: (ids, refs) => {
        citedIds = ids;
        ensureAssistant();
        useChatStore.getState().setAssistantRefs(refs);
      },
      onToken: (t) => {
        ensureAssistant();
        useChatStore.getState().appendAssistantToken(t);
      },
      onThinking: (t) => {
        // Thinking events can land before any cited/token. Mark
        // assistantStarted so a later token doesn't try to call
        // beginAssistant on top of the placeholder thinking already
        // created — see store.appendAssistantThinking for the lazy
        // bubble-creation path.
        assistantStarted = true;
        useChatStore.getState().appendAssistantThinking(t);
      },
      onThinkingEnd: () => {
        useChatStore.getState().endAssistantThinking();
      },
      onDone: (returnedCid) => {
        ensureAssistant();
        const s = useChatStore.getState();
        s.finishAssistant(citedIds);
        // 首发新会话:落定后端回传的 id 并刷新列表,后续轮次便复用同一条会话(不再孤儿化)。
        if (!cid && returnedCid) {
          s.setActiveConversationId(returnedCid);
          void s.loadConversations();
        }
      },
      onError: (m) => useChatStore.getState().setError(m),
    });
  }

  // Bubble is hidden in pinned mode — the dock IS the surface, and a
  // bubble on top of it would look redundant. We render it whenever
  // we're NOT in the (open + pinned) state.
  const showBubble = !(isOpen && isPinned);

  // Drag handlers. When `bubblePos` is set we render the button at an
  // absolute viewport position; otherwise it stays at the default
  // bottom-right corner. The drag commits its final position back to
  // the store on pointerup — persisted across reloads (see chat
  // store's partialize).
  function onBubblePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return; // left button only
    const rect = e.currentTarget.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
    };
    // Capture the pointer so pointermove keeps firing even if the
    // cursor briefly leaves the button.
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onBubblePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const s = dragState.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    s.moved = true;
    // Clamp inside the viewport so the user can always grab the
    // bubble back. 8px margin from each edge keeps it from going
    // flush against the side.
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - BUBBLE_SIZE - margin, s.startLeft + dx));
    const top = Math.max(margin, Math.min(window.innerHeight - BUBBLE_SIZE - margin, s.startTop + dy));
    const btn = e.currentTarget;
    // Direct DOM update during drag — re-rendering through React on
    // every move tanks frame rate; we let go of the dragged position
    // back into state in pointerup.
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  }
  function onBubblePointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const s = dragState.current;
    dragState.current = null;
    if (!s) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (s.moved) {
      // Commit the resting position. We read it back from the DOM so
      // we use the clamped value, not the raw delta.
      const rect = e.currentTarget.getBoundingClientRect();
      setBubblePos({ left: rect.left, top: rect.top });
      justDragged.current = true;
    }
  }
  function onBubbleClick() {
    // Suppress the synthesized click that follows a drag — otherwise
    // every drag would also flip the panel open/closed.
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    setOpen(!isOpen);
  }

  // Clamp on every render so a stored position from a wider window
  // doesn't leave the bubble half off-screen after a resize.
  const dragStyle: React.CSSProperties | undefined = bubblePos
    ? (() => {
        const margin = 8;
        const left = Math.max(margin, Math.min(window.innerWidth - BUBBLE_SIZE - margin, bubblePos.left));
        const top = Math.max(margin, Math.min(window.innerHeight - BUBBLE_SIZE - margin, bubblePos.top));
        return { left, top, right: "auto", bottom: "auto" };
      })()
    : undefined;

  if (onHome || onChatRoute || suppressed) return null;

  return (
    <>
      {showBubble && (
        <button
          type="button"
          onClick={onBubbleClick}
          onPointerDown={onBubblePointerDown}
          onPointerMove={onBubblePointerMove}
          onPointerUp={onBubblePointerUp}
          aria-label={isOpen ? `关闭 ${getAssistantName()}` : `打开 ${getAssistantName()}`}
          aria-pressed={isOpen}
          style={dragStyle}
          className="fixed bottom-6 right-6 z-40 flex h-12 w-12 cursor-grab touch-none select-none items-center justify-center rounded-full bg-primary text-primary-fg shadow-pop transition hover:scale-105 active:scale-95 active:cursor-grabbing"
        >
          {isOpen ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          )}
        </button>
      )}

      {isOpen && (
        <div
          role="dialog"
          aria-label={getAssistantName()}
          className={cn(
            "z-40 flex flex-col bg-white",
            isPinned
              // Docked: glued to the right edge, full-height under
              // the 64px (h-16) header. No rounded corners on the
              // edge that meets the viewport.
              ? "fixed right-0 bottom-0 w-[360px] border-l border-line shadow-glassLg animate-fade-up"
              // Floating: bottom-right popover above the bubble.
              : "fixed bottom-24 right-6 h-[560px] max-h-[80vh] w-[400px] max-w-[92vw] rounded-xl border border-line shadow-glassLg animate-pop-in",
          )}
          style={isPinned ? { top: "4rem" } : undefined}
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              {getAssistantName()}
              {(status === "sending" || status === "streaming") ? (
                // "Thinking" hint stays up until the AI's reply is fully
                // landed (status flips back to idle). ChatMessageList
                // hides the in-progress assistant bubble during the
                // same window, so the user sees pulsing dots + this hint
                // until the answer drops in fully formed.
                <span className="text-xs font-normal text-muted">正在思考中…</span>
              ) : activeArticleId ? (
                // Dynamic context hint — tells the user the chat is
                // currently scoped to the article they're reading, so
                // questions like "总结这篇" reliably ground on it.
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                  本文
                </span>
              ) : (
                <span className="text-xs font-normal text-muted">已发布文档</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPinned(!isPinned)}
                aria-label={isPinned ? "取消固定" : "固定到右侧"}
                aria-pressed={isPinned}
                title={isPinned ? "取消固定" : "固定到右侧"}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg transition",
                  isPinned ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface hover:text-fg",
                )}
              >
                <PinIcon filled={isPinned} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
          </header>
          <ChatMessageList
            messages={messages}
            status={status}
            error={error}
            summary={summary}
            summaryUpToMessageId={summaryUpToMessageId}
            isThinking={isThinking}
            selecting={selecting}
            onSelectingChange={setSelecting}
            hasMoreOlder={hasMoreOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={() => useChatStore.getState().loadOlder()}
          />
          <ChatComposer
            onSend={onSend}
            disabled={status === "sending" || status === "streaming"}
            onShare={messages.length > 0 ? () => setSelecting((s) => !s) : undefined}
            shareActive={selecting}
            onStop={() => {
              // Mirror HomeChatPanel: abort the fetch then patch the
              // store. AiBubble uses the same store, so the in-flight
              // bubble (whichever surface the user opened) sees the
              // status flip and the ⚠ marker on the user msg.
              abortRef.current?.abort();
              useChatStore.getState().stopChat();
            }}
          />
        </div>
      )}
    </>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  // Simple "pushpin" glyph; we toggle fill for the active state so
  // pinned is unambiguous at a glance.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 10.76V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 14.24V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z" />
    </svg>
  );
}
