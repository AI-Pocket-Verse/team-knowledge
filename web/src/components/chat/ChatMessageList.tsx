import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { MentionRef } from "@team-knowledge/shared";
import type { UiChatMessage } from "@/stores/chat";
import { ChatMarkdown } from "./ChatMarkdown";
import { ExpertAnswerExtras } from "./ExpertAnswerExtras";
import { ShareToDocDialog } from "./ShareToDocDialog";
import { ShareToImageDialog } from "./ShareToImageDialog";
import { cn } from "@/lib/cn";
import { uploadSrc } from "@/lib/api";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { formatChatTimestamp, shouldShowChatTimestamp } from "@/lib/formatChatTime";
import { useT } from "@/i18n";

// Where a mention chip in the rendered history bubble should
// navigate to when clicked. Matches the existing top-level routes —
// `/d/<id>` for docs, `/f/<id>` for folders, `/r/<id>` for roles AND
// skills (a skill's id is its roleId, so it links to the role page).
// If the target was deleted server-side, the destination page will
// surface its own 404 / "not accessible" message; the chip itself
// stays clickable so the user can confirm what happened.
function hrefForMention(ref: MentionRef): string {
  if (ref.type === "doc") return `/d/${ref.id}`;
  if (ref.type === "folder") return `/f/${ref.id}`;
  return `/r/${ref.id}`;
}

// Render a user message's plain-text body with inline @-mention chips
// — the visual match for what the composer showed at send time.
// Walks `content` once with a single regex built from the mention
// labels (sorted longest-first so `@文档AB` matches before `@文档A`).
// Falls back to plain string when there are no mentions to splice in.
function renderUserContentWithMentions(content: string, mentions: MentionRef[]): ReactNode {
  if (mentions.length === 0) return content;
  const sorted = [...mentions].sort((a, b) => b.label.length - a.label.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`@(${sorted.map((m) => escape(m.label)).join("|")})`, "g");
  const parts: Array<string | MentionRef> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index));
    const label = match[1];
    // Walk in original-mentions order so the first matching ref wins
    // when labels collide (e.g. a folder + role both named "前端").
    const ref = mentions.find((m) => m.label === label);
    if (ref) parts.push(ref);
    else parts.push(match[0]);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));

  return parts.map((p, i) => {
    if (typeof p === "string") return <span key={i}>{p}</span>;
    const icon = p.type === "doc" ? "📄" : p.type === "folder" ? "📁" : p.type === "skill" ? "🧩" : "👤";
    // Use a react-router Link so click jumps to the doc/folder/role
    // without a full page reload. Re-uses `.tm-mention-chip` from
    // index.css for visual parity with the composer; the user-select
    // rule on the class is inert inside a read-only bubble, the
    // hover/cursor rules now actually mean something.
    return (
      <Link key={i} to={hrefForMention(p)} className="tm-mention-chip">
        <span aria-hidden>{icon}</span>
        <span>{p.label}</span>
      </Link>
    );
  });
}

// Small wrapper that memoizes the parsed user content (chips
// spliced in at @-mention positions). Without this, every render
// of the list — including token-by-token streaming of an unrelated
// assistant turn — rebuilt the mention regex and re-walked each
// user message's content. Deps are `content` (immutable per message
// id after persist) and `mentions` (reference-stable when supplied
// directly from the store), so the memo hits on every restream.
function UserContent({ content, mentions }: { content: string; mentions: MentionRef[] }) {
  const nodes = useMemo(() => renderUserContentWithMentions(content, mentions), [content, mentions]);
  return <>{nodes}</>;
}

// Render the assistant's extended-thinking trace above the answer
// bubble. Three visual modes driven by (active, text):
//   active=true                 → pulsing "💭 深度思考中…" + (if
//                                  text) live-streaming reasoning
//                                  body that scrolls itself.
//   active=false, text === ""   → static "💭 已深度思考" badge. No
//                                  expand affordance — the CLI only
//                                  surfaced a signature, no raw text.
//   active=false, text !== ""   → click-to-toggle. Folded by default
//                                  so completed answers stay tidy;
//                                  hover hint says "点击展开".
// Module-level so React identity is stable across renders of the
// owning message list (preserves the user's expanded/folded choice
// for each card across token-driven re-renders).
function ThinkingCard({ text, active }: { text: string; active: boolean }) {
  const t = useT();
  // Default-expanded WHILE thinking so the user can watch reasoning
  // arrive live (mimics OpenAI o1 / Claude reasoning UIs). Once
  // active flips to false, leave it as-is — the user can collapse
  // manually. If they never expanded, it stays folded post-turn.
  const [expanded, setExpanded] = useState(false);
  // Auto-expand on the first thinking text while still active.
  // Tracks whether we've ever opened it ourselves so we don't
  // re-open after the user collapsed mid-stream. `useLayoutEffect`
  // runs synchronously before the browser paints, so the user
  // never sees a frame of "collapsed card + thinking text waiting"
  // — the card lands on screen already opened.
  const autoOpenedRef = useRef(false);
  useLayoutEffect(() => {
    if (active && text.length > 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setExpanded(true);
    }
  }, [active, text]);

  const hasBody = text.length > 0;
  const canToggle = hasBody;
  const label = active
    ? t("chat.list.thinkingActive")
    : hasBody
      ? (expanded ? t("chat.list.thinkingCollapse") : t("chat.list.thinkingExpand"))
      : t("chat.list.thinkingDone");

  return (
    <div className="max-w-[85%] rounded-xl border border-line bg-surface px-3 py-2 text-xs">
      <button
        type="button"
        disabled={!canToggle}
        onClick={() => canToggle && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1.5 text-muted",
          canToggle && "cursor-pointer hover:text-fg transition",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block",
            // Only pulse during active thinking; once done the
            // emoji stays static so a finished card doesn't compete
            // for attention with the answer bubble below it.
            active && "tm-dot-pulse",
          )}
        >💭</span>
        <span>{label}</span>
        {canToggle && (
          <span className="ml-auto inline-flex"><CollapseChevron open={expanded} /></span>
        )}
      </button>
      {hasBody && expanded && (
        // 按空行把思考拆成多段分别展示(每次思考/每个自然段一段),而不是糊成一坨。
        // 段内 pre-wrap 保留换行;max-height + overflow 兜住超长思考不把答复挤出屏。
        <div className="mt-2 max-h-60 space-y-2 overflow-y-auto text-fg/70 leading-relaxed">
          {text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map((seg, i) => (
            <p key={i} className="whitespace-pre-wrap">{seg}</p>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  messages: UiChatMessage[];
  status: "idle" | "sending" | "streaming" | "error";
  error: string | null;
  /** Rolling-summary text from the server; if non-null we render a
   *  folded "之前对话(已总结)" expander above the newer messages and
   *  surface the summary as its preview. */
  summary?: string | null;
  /** Id of the most recent message captured by `summary`. Messages
   *  with this id and older fold; messages after stay visible. */
  summaryUpToMessageId?: string | null;
  /** True while the in-flight assistant turn is inside a thinking
   *  block. Drives the pulsing "💭 深度思考中…" badge on the LAST
   *  assistant message. After the block closes (or done/error
   *  arrives) this flips false and the badge collapses. Always
   *  false for non-thinking providers, so they never see the badge. */
  isThinking?: boolean;
  /** roleId → 显示名(用于专家附加件的 trace / 状态文案)。缺省退化为原样返回 id。 */
  roleName?: (id: string) => string;
  /** 升级卡就地拍板/转交后回调(上层标记该消息 escalationHandled)。 */
  onEscalationHandled?: (messageId: string) => void;
  /** 多选分享模式(受控:入口在 composer 的分享按钮,由上层切换)。 */
  selecting?: boolean;
  onSelectingChange?: (v: boolean) => void;
  /** 上滑懒加载:是否还有更早消息 / 是否正在加载 / 触发加载。 */
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** 该会话正在「后台」生成回复(本视图没有实时草稿,如切走再切回的会话)。
   *  与 status=streaming 一样驱动「正在回复」指示(三点),但 status 仍为 idle(好让
   *  完成时的服务端重拉能把答复显示出来)。 */
  replying?: boolean;
  /** 是否自动滚到底部(默认 true = 聊天行为)。阅读型复用(如自动化运行详情)传 false,
   *  让长文从顶部起读、不被强制拉到末尾。 */
  autoScroll?: boolean;
}

export function ChatMessageList({ messages, status, error, isThinking = false, roleName = (id) => id, onEscalationHandled = () => {}, selecting = false, onSelectingChange = () => {}, hasMoreOlder = false, loadingOlder = false, onLoadOlder = () => {}, replying = false, autoScroll = true }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  // The first scroll-to-bottom runs in `useLayoutEffect` so it
  // happens BEFORE the browser paints — the user lands directly on
  // the latest reply with no visible "scrollbar at top → animates
  // down" flash on open. Subsequent updates (streaming tokens,
  // new messages) go through `useEffect` with smooth scrolling so
  // token chunks visibly chase the bottom rather than teleporting
  // on every chunk. Splitting the two is what gives "instant on
  // open, smooth while streaming" without paying the
  // synchronous-before-paint cost on every token.
  const firstScroll = useRef(true);
  // 上滑 prepend 时保持视觉位置:记录加载前的 scrollHeight/scrollTop,prepend 后用差值校正。
  const pendingPrepend = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const skipBottom = useRef(false);
  useLayoutEffect(() => {
    if (!autoScroll) return; // 阅读型复用:不强制滚到底,保持顶部起读
    if (!firstScroll.current) return;
    const el = ref.current;
    if (!el) return;
    // Wait for content. On a cold open, messages may be `[]` for
    // one render (hydration is async); scrolling an empty list is
    // a no-op, then the smooth-scroll branch below would kick in
    // for the hydrated render — bringing back the very animate-
    // from-top flash this whole split is meant to prevent.
    // Defer the "first scroll" claim until a render with actual
    // rows lands, so the instant-jump happens THERE (before paint).
    if (messages.length === 0) return;
    firstScroll.current = false;
    el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (!autoScroll) return; // 阅读型复用:禁用流式追底
    if (firstScroll.current) return;
    if (skipBottom.current) { skipBottom.current = false; return; } // 这次是 prepend 更早消息,别滚到底
    const el = ref.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      // JSDOM + a couple of older browsers without scrollTo.
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status]);
  // prepend 更早消息后,把 scrollTop 往下推「新增高度」,让顶部可见消息留在原位(不跳)。
  useLayoutEffect(() => {
    const el = ref.current;
    const p = pendingPrepend.current;
    if (!el || !p) return;
    el.scrollTop = p.prevTop + (el.scrollHeight - p.prevHeight);
    pendingPrepend.current = null;
    skipBottom.current = true; // 阻止随后那次 smooth-to-bottom
  }, [messages]);
  // 加载失败兜底:loadingOlder 落回 false 但 messages 未变(prepend 没成功)→ 清掉残留锚点。
  // 否则 onScrollList 的 pendingPrepend 守卫会永久卡死(再也触发不了加载),且下次 messages
  // 变化(如发新消息)会用这个过期锚点错误校正 scrollTop。成功路径下 messages 先变、上面的
  // layout effect 已把锚点清掉,此处 no-op。
  useEffect(() => {
    if (!loadingOlder && pendingPrepend.current) pendingPrepend.current = null;
  }, [loadingOlder]);
  // 滚动到接近顶部 + 还有更早消息 + 非加载中 → 记录锚点并触发加载。
  function onScrollList() {
    const el = ref.current;
    if (!el) return;
    if (el.scrollTop <= 24 && hasMoreOlder && !loadingOlder && !pendingPrepend.current) {
      pendingPrepend.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
      onLoadOlder();
    }
  }

  // replying(后台生成中)与 sending/streaming 同样算「忙」→ 复用同一套「正在回复」指示
  //(三点 / 空占位隐藏)。status 本身仍是 idle,不影响完成时的服务端重拉。
  const isBusy = status === "sending" || status === "streaming" || replying;

  // Defensive sort by (createdAt, id) so even if the server returns
  // messages with colliding timestamps in arbitrary order, the UI
  // alternates user → assistant correctly. The server already sorts
  // this way for fresh fetches, but legacy rows persisted before that
  // fix could still tie on createdAt; cuid is time-monotonic so id is
  // a sound tiebreaker.
  const ordered = useMemo(() => {
    const copy = messages.slice();
    copy.sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return copy;
  }, [messages]);

  // Show the streaming bubble live — tokens visibly accumulate in
  // place as they arrive, so the user sees progress instead of a
  // multi-minute wall of pulsing dots. The 3-dot loader only covers
  // the window before the first content token lands:
  //   - status === "sending": request in flight, no assistant bubble yet
  //   - status === "streaming" + cited arrived, no token yet: an
  //     empty assistant placeholder exists (beginAssistant ran on
  //     the cited event) — we hide it so the dots don't sit beside
  //     an empty rounded box.
  // Once any token is in, the bubble takes over and the dots
  // disappear; the final reply is the same DOM node that was
  // growing, no swap at "done".
  // The last assistant message counts as "has something to show" if
  // it has text content OR thinking surface area (badge/card). We
  // only hide the placeholder + show dots when there is truly
  // nothing yet — pre-cited "sending" or cited-fired-no-thinking-
  // no-token. Once thinking starts, the thinking card replaces the
  // dots on the same row so the user immediately sees progress.
  const last = ordered[ordered.length - 1];
  const lastIsAssistant = !!last && last.role === "assistant";
  // 专家轮次(trace !== undefined)即便正文为空也算「有内容」:不裁掉空占位,
  // 改由 ExpertAnswerExtras 渲染实时阶段状态(非流式 provider 也有进展反馈)。
  const lastHasContent = lastIsAssistant && (last.content !== "" || last.thinking !== undefined || last.trace !== undefined);
  const showDots = isBusy && !lastHasContent;
  // Memoized so downstream useMemo'd derivations (messagesWithTime,
  // anchorIdx) actually cache between renders — without this they
  // would see a fresh `visibleMessages` reference every render and
  // recompute uselessly. Deps are the booleans we already derived,
  // so re-evaluation only happens when the visibility decision
  // actually flips (i.e. the placeholder appears or disappears).
  const visibleMessages = useMemo(
    () => (lastIsAssistant && !lastHasContent ? ordered.slice(0, -1) : ordered),
    [ordered, lastIsAssistant, lastHasContent],
  );

  // Decorate each visible message with whether to render a centered
  // timestamp divider ABOVE it (WeChat-style grouping). The helper
  // hides timestamps within a 10-minute same-day burst; first message
  // and cross-day boundaries always show.
  const messagesWithTime = useMemo(
    () => visibleMessages.map((m, i, arr) => ({
      m,
      showTime: shouldShowChatTimestamp(m.createdAt, i > 0 ? arr[i - 1].createdAt : null),
    })),
    [visibleMessages],
  );

  // 全展开:所有消息都平铺、按 20 轮分页(上滑加载更早)。不再在顶部挂「AI 记忆为摘要」
  // 聚合提示——后端滚动摘要仍作为 AI 的长对话记忆存在,只是不在界面上呈现这层聚合。

  // Derive from `visibleMessages` (not `ordered`) so the "isLast"
  // check in renderRow always matches the actually-rendered last
  // row. If we used `ordered` and the trailing empty assistant
  // placeholder was filtered out, `isLast` would silently be false
  // for every visible row — breaking the ThinkingCard "active"
  // animation and any future last-row affordance.
  const lastMessageId = visibleMessages[visibleMessages.length - 1]?.id ?? null;

  // ─── Multi-select → share-to-doc ───────────────────────────
  // Selection is ephemeral UI state (not in the chat store): the user flips
  // into select mode, ticks messages, and shares them into a new document.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareOpen, setShareOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  // 退出多选时清空已选(取消按钮或外部关闭多选都生效)。
  useEffect(() => { if (!selecting) setSelected(new Set()); }, [selecting]);
  // Selection must be robust to `visibleMessages` changing length while
  // the user is picking rows: a streaming reply's empty placeholder
  // appears/disappears mid-selection, and rows scroll out of `ordered`
  // only in pathological cases — but the transient placeholder alone
  // was enough to make "全选" flip spuriously and to silently drop
  // already-selected ids that weren't in the current `visibleMessages`
  // snapshot. Derive everything from the STABLE set of *selectable*
  // (real, persisted) message ids — the empty trailing assistant
  // placeholder (content === "") is never selectable — and never
  // discard a selected id just because the placeholder toggled.
  const selectableIds = useMemo(
    () => ordered.filter((m) => !(m.role === "assistant" && m.content === "" && !(m.images?.length))).map((m) => m.id),
    [ordered],
  );
  const selectableIdSet = useMemo(() => new Set(selectableIds), [selectableIds]);
  // "全选" reflects whether every currently-selectable row is ticked,
  // ignoring any stale ids the selection may still hold (e.g. a row that
  // briefly left the list). Empty selectable set → not "all selected".
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(() => (allSelected ? new Set() : new Set(selectableIds)));
  }
  function exitSelect() {
    onSelectingChange(false);
    setSelected(new Set());
  }

  function renderRow(item: { m: UiChatMessage; showTime: boolean }): ReactNode {
    const { m, showTime } = item;
    const isUser = m.role === "user";
    const isLast = m.id === lastMessageId;
    // The thinking card renders ABOVE the bubble for assistant
    // messages that captured any reasoning. While this is the in-
    // flight turn AND store.isThinking is true, the card pulses
    // "深度思考中"; after that it collapses to a click-to-expand
    // affordance (or a static badge if no raw text was surfaced).
    const showThinking = !isUser && m.thinking !== undefined;
    // Hide the bubble entirely for assistant messages that have a
    // thinking card but no answer text yet — otherwise we'd render
    // an empty rounded box below the card. Once the first answer
    // token lands content !== "" and the bubble appears in place.
    // 例外:生图结果是「正文为空 + 只有图片」(叙述已移到思考卡),此时必须显示气泡来渲染图。
    const showBubble = !(m.role === "assistant" && m.content === "" && !(m.images?.length));
    // Wrapper hosts an optional centered timestamp divider above the
    // bubble; the inner row keeps the original left/right alignment of the
    // message itself. In select mode the same body is wrapped in a
    // checkbox row instead (see below).
    const body = (
      <>
        {showTime && (
          <div className="text-center text-[10px] text-muted py-1">
            {formatChatTimestamp(m.createdAt)}
          </div>
        )}
        {showThinking && (
          <div className="flex justify-start mb-2">
            <ThinkingCard text={m.thinking ?? ""} active={isLast && isThinking} />
          </div>
        )}
        {showBubble && (
        <div className={cn("flex items-start gap-1.5", isUser ? "justify-end" : "justify-start")}>
          {isUser && m.aborted && (
            // ⚠ marker shown when this user turn was interrupted by
            // the stop button. Renders just LEFT of the bubble
            // (justify-end pushes the whole group right, icon-then-
            // bubble keeps natural reading order). Visual: red
            // circle with white "!" — same vocab as banking apps
            // for "this transaction needed attention".
            <span
              className="mt-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[12px] font-bold leading-none text-white"
              title={t("chat.list.interrupted")}
              aria-label={t("chat.list.interrupted")}
            >!</span>
          )}
          <div className={cn(
            // User bubble keeps `whitespace-pre-wrap` because user
            // input is plain text — preserve their literal line
            // breaks. Assistant bubble lets ChatMarkdown control
            // block structure (paragraphs / lists / code) directly.
            "max-w-[85%] break-words rounded-xl p-5",
            isUser ? "whitespace-pre-wrap bg-accent-soft text-fg rounded-br-sm"
                   : "bg-surface text-fg rounded-bl-sm",
          )}>
            {(m.images?.length ?? 0) > 0 && (
              // 图片:用户消息=随消息上传的图;assistant 消息=AI 生成的图。点开新标签看原图。
              // 图在上、文字在下,与飞书图文消息观感一致。AI 生成图给更大预览。
              <div className={cn("flex flex-wrap gap-2", m.content.trim() && "mb-2")}>
                {m.images!.map((url) => (
                  <a key={url} href={uploadSrc(url)} target="_blank" rel="noreferrer" className="block">
                    <img
                      src={uploadSrc(url)}
                      alt={isUser ? t("chat.list.imageUser") : t("chat.list.imageAi")}
                      className={cn(
                        "rounded-lg border border-line object-cover",
                        isUser ? "max-h-40 max-w-[12rem]" : "max-h-72 max-w-[20rem]",
                      )}
                    />
                  </a>
                ))}
              </div>
            )}
            {isUser
              // User content: splice inline mention chips at each
              // `@<label>` occurrence so the bubble visually matches
              // what the composer showed. Snapshot labels come from
              // the server (db-resolved at send time) — chips still
              // render after the underlying doc/folder/role is
              // renamed or deleted.
              ? (m.content.trim() ? <UserContent content={m.content} mentions={m.mentions ?? []} /> : null)
              : <ChatMarkdown text={m.content} refs={m.citedRefs} />}
          </div>
        </div>
        )}
        {!isUser && (
          <div className="flex justify-start">
            <div className="max-w-[88%]">
              <ExpertAnswerExtras
                m={m}
                roleName={roleName}
                streaming={isLast && isBusy}
                onEscalationHandled={onEscalationHandled}
              />
            </div>
          </div>
        )}
      </>
    );
    // In select mode each message becomes a checkbox row; the body's own
    // links/buttons are disabled (pointer-events-none) so a click toggles
    // selection instead of navigating.
    if (selecting) {
      const checked = selected.has(m.id);
      return (
        <div
          key={m.id}
          onClick={() => toggleOne(m.id)}
          className={cn(
            "flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 transition",
            checked ? "bg-accent-soft ring-1 ring-primary/30" : "hover:bg-surface",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold leading-none",
              checked ? "border-primary bg-primary text-white" : "border-line bg-white text-transparent",
            )}
          >✓</span>
          <div className="pointer-events-none min-w-0 flex-1">{body}</div>
        </div>
      );
    }
    return <div key={m.id} className="flex flex-col">{body}</div>;
  }

  // Share only real persisted rows that are still selectable, in
  // chronological order. Sourced from `ordered` (not `visibleMessages`)
  // so a transient placeholder toggling can't drop a chosen row, and
  // filtered through `selectableIdSet` so a stale id can't sneak the
  // empty placeholder into the shared doc.
  const selectedRows = ordered.filter((m) => selectableIdSet.has(m.id) && selected.has(m.id));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 多选态:顶部居中浮出的紧凑胶囊条(无整行、无分隔横线)。入口在 composer 的分享按钮。 */}
      {selecting && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-xs shadow-glassLg">
            <span className="text-muted">{t("chat.list.selectedPre")}<b className="text-fg">{selectedRows.length}</b>{t("chat.list.selectedPost")}</span>
            <button type="button" onClick={toggleAll} className="rounded-lg px-2 py-1 text-muted transition hover:bg-surface hover:text-fg">
              {allSelected ? t("chat.list.deselectAll") : t("chat.list.selectAll")}
            </button>
            <button type="button" onClick={exitSelect} className="rounded-lg px-2 py-1 text-muted transition hover:bg-surface hover:text-fg">
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={selectedRows.length === 0}
              onClick={() => setImageOpen(true)}
              className="rounded-lg border border-line bg-white px-2.5 py-1 font-medium text-fg transition enabled:hover:bg-surface disabled:opacity-50"
            >
              {t("chat.list.makeImage")}
            </button>
            <button
              type="button"
              disabled={selectedRows.length === 0}
              onClick={() => setShareOpen(true)}
              className="rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-fg transition enabled:hover:bg-primary/90 disabled:opacity-50"
            >
              {t("chat.list.shareToDoc")}
            </button>
          </div>
        </div>
      )}
      <div ref={ref} onScroll={onScrollList} className="flex-1 overflow-y-auto px-5 pt-5 pb-3 space-y-3 text-sm">
      {(loadingOlder || hasMoreOlder) && (
        <div className="py-1 text-center text-[11px] text-muted">
          {loadingOlder ? t("chat.list.loadingOlder") : t("chat.list.loadOlderHint")}
        </div>
      )}
      {visibleMessages.length === 0 && !isBusy && (
        <div className="text-center text-xs text-muted">
          {t("chat.list.emptyHint")}
        </div>
      )}
      {messagesWithTime.map(renderRow)}
      {status === "error" && error && (
        <div className="text-xs text-rose-600">⚠ {error}</div>
      )}
      {showDots && (
        // Three brand-violet dots that scale up sequentially (one at a
        // time). The `tm-dot-pulse` class + keyframes live in index.css
        // — we keep them out of tailwind.config so HMR doesn't have to
        // regenerate utilities on every visit. Inline animationDelay
        // staggers each dot by 500ms across the 1.5s cycle so dot 1
        // grows→shrinks, then dot 2, then dot 3, then repeat.
        <div className="flex justify-start">
          <div className="flex items-center gap-2 rounded-xl rounded-bl-sm bg-surface px-5 py-4">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full bg-primary tm-dot-pulse"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="inline-block h-2.5 w-2.5 rounded-full bg-primary tm-dot-pulse"
              style={{ animationDelay: "500ms" }}
            />
            <span
              className="inline-block h-2.5 w-2.5 rounded-full bg-primary tm-dot-pulse"
              style={{ animationDelay: "1000ms" }}
            />
          </div>
        </div>
      )}
      </div>
      {shareOpen && (
        <ShareToDocDialog
          messages={selectedRows}
          onClose={() => setShareOpen(false)}
          onShared={() => { setShareOpen(false); exitSelect(); }}
        />
      )}
      {imageOpen && (
        <ShareToImageDialog
          messages={selectedRows}
          onClose={() => setImageOpen(false)}
        />
      )}
    </div>
  );
}
