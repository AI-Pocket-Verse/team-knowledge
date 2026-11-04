import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatMessageRow, CitationRef, MentionRef } from "@team-knowledge/shared";
import type { ExpertCitation, ExpertTraceEvent, EscalationDetail, ExpertChatResult, ConversationListItem } from "@/lib/api";
import { api } from "@/lib/api";
import { getAssistantName } from "@/lib/assistantName";
import { tr } from "@/i18n";

// 统一聊天的消息行 = 持久化行 + 仅前端的专家附加态(均可选,气泡旧链路留空)。
// 判别「专家轮次」靠 trace !== undefined(beginAssistantExpert 播种 [])。
export interface UiChatMessage extends ChatMessageRow {
  targets?: string[];               // 本轮选中的专家 roleIds(回显 + 状态文案)
  trace?: ExpertTraceEvent[];       // 编排过程事件(实时累计 / 终稿)
  citations?: ExpertCitation[];     // 出处芯片(doc/meeting/group-qa/web)
  escalation?: EscalationDetail;    // 命中升级时的决策卡数据
  escalationHandled?: boolean;      // 卡片已就地拍板/转交
}

interface UiState {
  isOpen: boolean;
  // When true the AI panel docks as a full-height right-side column
  // (and the workspace main area reserves space for it). When false
  // it's a floating bubble + centered popover. Persisted so the
  // user's preference survives reloads.
  isPinned: boolean;
  // Optional override for the floating bubble's viewport position
  // (when the user has dragged it). Null = use the default
  // bottom-6 right-6 corner. Stored as viewport-relative top-left
  // pixels for both axes so a window resize can re-clamp cleanly.
  bubblePos: { left: number; top: number } | null;
}

// 单个会话的运行态 entry(见 runtimeByConversation)。
export interface ConvRuntime {
  generating: boolean;       // 本会话有在飞轮次(切回时据此显示「正在回复」占位 + 锁输入 + 显示停止键)
  targets: string[];         // 已选专家 roleIds(空=总台)
  composerHtml: string;      // 输入框草稿(innerHTML,保留 @ 芯片);切走存、切回填
  composerImages: string[];  // 待发送图片(/uploads 视图)
}

interface RuntimeState {
  messages: UiChatMessage[];
  // 选择条选中的专家 roleIds(空=总台分诊)。顶层 UI 态:跨页导航保留,reset 清空。
  targets: string[];
  status: "idle" | "sending" | "streaming" | "error";
  error: string | null;
  conversationId: string | null;
  // (O6) Rolling-summary snapshot from the server. The UI uses these
  // to fold messages with id ≤ summaryUpToMessageId behind a "📜 之
  // 前对话(已总结)" expander so a long chat doesn't show a wall of
  // old turns by default. Null on a fresh conversation.
  summary: string | null;
  summaryUpToMessageId: string | null;
  // Whether the in-flight assistant turn is currently inside a
  // thinking block. Set by appendAssistantThinking on the FIRST
  // event of the turn; cleared by endAssistantThinking or
  // finishAssistant (whichever fires first). The UI uses this to
  // pulse the "💭 深度思考中" badge while true; once false, the
  // badge collapses to "💭 已深度思考(展开)" iff the message has
  // any thinking text. Non-thinking turns never set this true,
  // so non-thinking models never show the badge.
  isThinking: boolean;
  // True while a REMOTE turn (started from Feishu, mirrored over the
  // /api/chat/stream SSE channel) is streaming into this page. Drives the
  // same composer-locked + typewriter UI as a local turn; cleared by
  // remoteFinish (remote_done/remote_error/stream reconnect resync).
  remoteStreaming: boolean;
  // 上滑懒加载分页:hasMoreOlder=是否还有更早的;loadingOlder=正在取更早一页。
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  // 多任务对话:该用户全部会话(左栏「对话」列表渲染源)。飞书置顶 + 其余按最近活跃倒序。
  conversations: ConversationListItem[];
  // 左栏会话列表分页:hasMore=还有更早的会话可加载;loadingMore=正在取下一页(每页 20 条)。
  conversationsHasMore: boolean;
  loadingMoreConversations: boolean;
  // 当前会话的标题 / 是否飞书 —— 供顶栏(RightTopBar)显示会话标题用。顶栏优先用会话列表里
  // 的同一条(保证与列表一致),列表里没有(如深链到超过分页上限的旧会话)时回退到这里。
  activeTitle: string | null;
  activeIsFeishu: boolean;
  // 切换/装载会话时「消息拉取失败」(与发送/流式的 error 分开)。非 null 时视图显示
  // 「加载失败·重试」,而不是把拉取失败误当成「空对话」渲染成 Hi助手落地页(此前
  // switchConversation 的 getConversation 抛错被 void 吞掉,messages 保持空 → 假空态,
  // 且路由 handled 已 latch 不再重试,只能靠切走再切回恢复)。切换成功即清空。
  loadError: string | null;
  // 正在切换到【另一条】会话且其消息尚未拉回:视图显示「加载中」而非旧内容 / 误导空态。
  // 同一会话的后台静默重拉(id 不变)不置此标,避免每轮结束闪一下加载态。
  switching: boolean;
  // 按会话统一的运行态表(替代散落的 generatingIds / targetsByConversation):凡是「逻辑上
  // 属于某会话」的运行态都收在这里 —— generating(有在飞轮)、targets(已选专家)、composer 草稿。
  // 切走/切回只切「当前活动 id」,视图从对应 entry 派生,后台轮的状态留在自己的 entry,切回即恢复。
  // 仅运行态(不持久化);中止句柄(AbortController)另存模块级 abortRegistry(非响应式)。
  // 未落定 id 的新对话用 NEW_KEY("")占位,首发拿到真 id 时整体迁移(见 setActiveConversationId)。
  runtimeByConversation: Record<string, ConvRuntime>;
}

interface ChatStore extends UiState, RuntimeState {
  setOpen(v: boolean): void;
  setPinned(v: boolean): void;
  setBubblePos(pos: { left: number; top: number } | null): void;
  /** 初始装载:先拉会话列表,再切到最近一条(无则进空态)。 */
  hydrate(): Promise<void>;
  /** 拉取会话列表第一页(左栏渲染源,每页 20 条);重置分页。 */
  loadConversations(): Promise<void>;
  /** 加载更多会话(下一页 20 条),去重追加到列表尾;无更多 / 加载中则不动。 */
  loadMoreConversations(): Promise<void>;
  /** 切到指定会话:清空并重载其消息/摘要。 */
  switchConversation(id: string): Promise<void>;
  /** 新对话空态:清空消息/选中,conversationId=null(首发时由路由落定 id)。 */
  newConversation(): void;
  /** 首发新会话后,把后端回传的新 id 落定到 store。 */
  setActiveConversationId(id: string): void;
  /** 标记某会话开始后台生成(发起轮次时);用于切回该会话时显示「正在回复」。 */
  beginGenerating(conversationId: string): void;
  /** 清除某会话的后台生成标记(轮次 done/error/中止时);同时丢弃它的中止句柄。 */
  endGenerating(conversationId: string): void;
  /** 登记某会话在飞轮次的中止句柄(发起轮次时);供切走后仍能定位该轮去中止。 */
  registerAbort(conversationId: string, ac: AbortController): void;
  /** 收尾某一轮(done/error/finally):仅当该会话登记的句柄仍是本轮 ac 才清 generating + 句柄,
   *  避免「停止后秒发同会话下一轮」时本轮迟到的收尾误清新轮。 */
  endTurn(conversationId: string, ac: AbortController): void;
  /** 中止某会话的在飞轮次:abort 其句柄 + 清生成中标记;若是当前视图,前台轮就地清理、
   *  后台轮重拉服务端已落的部分输出。供「停止生成」键调用,前台/后台一致。 */
  abortConversation(conversationId: string): void;
  /** 会话被删除时清掉它的所有运行态(entry + 中止句柄),避免孤儿残留。 */
  forgetConversation(conversationId: string): void;
  /** 写入当前会话的输入框草稿(innerHTML + 待发图片);切走存、切回填。 */
  setComposerDraft(html: string, images: string[]): void;
  /** 上滑到顶:取更早一页(20 轮 ≈ 40 条)prepend 到最前。hasMoreOlder=false 或加载中则不动。 */
  loadOlder(): Promise<void>;
  appendUser(content: string, mentions?: MentionRef[], images?: string[]): void;
  beginAssistant(): void;
  setTargets(fn: (prev: string[]) => string[]): void;
  /** 专家轮次起手:追加 assistant 草稿并播种 trace:[](判别标志)+ targets。
   *  返回该草稿的消息 id —— 调用方把它回传给后续 step/token/finish/fail,使这些写入
   *  只定向到本轮草稿;一旦用户切走会话(草稿不在当前视图),写入自动丢弃,不污染别的会话。 */
  beginAssistantExpert(targets: string[]): string;
  /** 把一个编排过程事件累计进目标 assistant 草稿的 trace(省略 messageId 则取最后一条)。 */
  appendAssistantStep(event: ExpertTraceEvent, messageId?: string): void;
  /** 专家轮次终稿:写 answer/citations/trace/escalation,status→idle(草稿不在视图则 no-op)。 */
  finishAssistantExpert(result: ExpertChatResult, messageId?: string): void;
  /** 专家轮次失败:正文为空时填错误文案,status→idle(草稿不在视图则 no-op)。 */
  failAssistantExpert(message: string, messageId?: string): void;
  /** 标记某条消息的升级卡已处理(就地隐藏卡片)。 */
  markEscalationHandled(messageId: string): void;
  appendAssistantToken(text: string, messageId?: string): void;
  /** Append a thinking delta to the in-flight assistant message.
   *  text === "" is the "thinking started" signal — sets isThinking
   *  true and seeds the message's thinking field with "" so the UI
   *  can distinguish "no thinking at all" (undefined) from
   *  "thinking happened, no text surfaced" (""). Subsequent calls
   *  with non-empty text accumulate. Safe to call before
   *  beginAssistant — it'll lazily create the placeholder.
   *  messageId 给定(统一/专家路径)= 定向到该草稿,切走则丢弃;
   *  缺省(旧 /chat/message 路径)= 沿用「最后一条 assistant」并惰性创建。 */
  appendAssistantThinking(text: string, messageId?: string): void;
  /** Flip isThinking false. Leaves the thinking text on the message
   *  intact so it stays expandable post-turn. */
  endAssistantThinking(): void;
  setAssistantRefs(refs: CitationRef[]): void;
  finishAssistant(citedArticleIds: string[]): void;
  setError(message: string): void;
  /** Called by the panel when the user clicks the in-flight stop
   *  button. Does NOT abort the fetch itself — the caller is
   *  expected to abort the AbortController first (it's held in a
   *  component ref). This method handles the store-side cleanup:
   *  marks the most recent USER message aborted (so the bubble can
   *  render a leading ⚠), drops the empty assistant placeholder if
   *  no token landed, and resets streaming flags to idle so the
   *  composer reopens. The server side keeps any partial assistant
   *  text it already streamed (req.raw "close" → SIGTERM →
   *  persistAssistant with the "（AI 中断,以下为部分输出)" suffix),
   *  so a page reload will show what the user did receive. */
  stopChat(): void;
  reset(): Promise<void>;
  /** A Feishu-originated turn began: append the user message + an empty
   *  assistant draft and lock the composer (status "streaming"), exactly
   *  like a locally-sent turn. No-op if a local turn is already in flight
   *  (the server's per-conversation lock makes that impossible anyway). */
  remoteStart(content: string, images?: string[]): void;
  /** Remote turn ended (done/error/resync): unlock and let the caller
   *  hydrate() to swap the temp drafts for canonical persisted rows. */
  remoteFinish(): void;
}

// Single store, with persist() partialized to ONLY the UI bools.
// Previously this was split into two stores (a persisted UI store + a
// runtime store reading uiStore.getState() at construction) which
// risked the initial values being out of sync with localStorage on
// platforms with async storage. partialize keeps the runtime state
// (messages, status, conversationId) out of the persisted JSON.
// 把服务端返回的消息映射为 UiChatMessage:assistant 行的 citedRefs(已权限过滤)→ citations,
// 这样刷新/翻页后出处芯片仍展示。供 hydrate 与 loadOlder 共用。
function hydrateRows(rows: ChatMessageRow[]): UiChatMessage[] {
  return rows.map((m) =>
    m.role === "assistant" && m.citedRefs.length > 0
      ? { ...m, citations: m.citedRefs.map((r) => ({ source: "doc" as const, title: r.title, ref: r.articleId })) }
      : m,
  );
}

// 未落定 id 的新对话占位 key:发送前选的专家 / 打的草稿 / 起手的中止句柄都先记在这个 key 下,
// 首发拿到真 id 时整体迁移到真 id(见 setActiveConversationId)。空串不会与任何真 conversationId 撞。
const NEW_KEY = "";
const activeKey = (conversationId: string | null): string => conversationId ?? NEW_KEY;
// 缺省 entry:rtOf 在 key 不存在时返回这个共享单例(冻结对象防误改字段;读字段 / patchRt 展开均安全)。
const EMPTY_RT: ConvRuntime = Object.freeze({ generating: false, targets: [] as string[], composerHtml: "", composerImages: [] as string[] });
function rtOf(map: Record<string, ConvRuntime>, key: string): ConvRuntime {
  return map[key] ?? EMPTY_RT;
}
function patchRt(map: Record<string, ConvRuntime>, key: string, patch: Partial<ConvRuntime>): Record<string, ConvRuntime> {
  return { ...map, [key]: { ...rtOf(map, key), ...patch } };
}
function dropRt(map: Record<string, ConvRuntime>, key: string): Record<string, ConvRuntime> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}
// 每会话「在飞轮次」的中止句柄。非响应式(中止是命令式操作,不需要触发重渲染),故不入 store、
// 不持久化。点停止键 → abortRegistry.get(会话).abort() → fetch 中止 → 服务端 req close → SIGTERM。
const abortRegistry = new Map<string, AbortController>();

// 左栏会话列表每页条数(分页「加载更多」)。
const CONV_PAGE = 20;
// 消息分页:每页 20 轮对话(一轮 = 用户 + AI 两条 ≈ 40 条消息)。首屏与上滑加载更早都用它。
const MSG_PAGE = 40;

// 单调递增的「切换会话」序号(模块级,单例 store):switchConversation 用它丢弃过期响应。
let switchSeq = 0;
// 单调递增的草稿序号:保证每轮 assistant 草稿 id 唯一(同毫秒并发也不撞),供按 id 定向写入。
let draftSeq = 0;

// 解析流式写入的目标消息下标:给了 messageId 就按 id 找(找不到返回 -1 → 调用方 no-op,
// 用于「已切走会话、草稿不在当前视图」时安全丢弃);没给则回退到最后一条 assistant(老链路如气泡)。
function targetAssistantIndex(messages: UiChatMessage[], messageId?: string): number {
  if (messageId) return messages.findIndex((m) => m.id === messageId);
  const last = messages.length - 1;
  return last >= 0 && messages[last]!.role === "assistant" ? last : -1;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      isOpen: false,
      isPinned: false,
      bubblePos: null,
      messages: [],
      status: "idle",
      error: null,
      conversationId: null,
      summary: null,
      summaryUpToMessageId: null,
      isThinking: false,
      remoteStreaming: false,
      targets: [],
      hasMoreOlder: false,
      loadingOlder: false,
      conversations: [],
      conversationsHasMore: false,
      loadingMoreConversations: false,
      activeTitle: null,
      activeIsFeishu: false,
      loadError: null,
      switching: false,
      runtimeByConversation: {},

      setOpen(v) {
        set({ isOpen: v });
      },

      setPinned(v) {
        // Pinning forces open. Unpinning leaves isOpen as-is so the
        // user can pin → close-via-X → unpin without an extra step.
        set((s) => ({ isPinned: v, isOpen: v || s.isOpen }));
      },

      setBubblePos(pos) {
        set({ bubblePos: pos });
      },

      async loadConversations() {
        // 刷新列表(含飞书置顶)。保留已展开的页数:取至少当前已加载的非飞书条数,否则发完一轮 /
        // 改名 / 置顶后列表会缩回 20 条(用户已「加载更多」展开的会被收起)。每页基准 20。
        const loaded = useChatStore.getState().conversations.filter((c) => !c.isFeishu).length;
        const r = await api.chat.listConversations({ limit: Math.max(CONV_PAGE, loaded) });
        set({ conversations: r.items, conversationsHasMore: r.hasMore, loadingMoreConversations: false });
      },

      async loadMoreConversations() {
        const s = useChatStore.getState();
        if (!s.conversationsHasMore || s.loadingMoreConversations) return;
        // offset 按「已加载的非飞书条数」算(飞书只在第一页、不参与 DB 翻页)。
        const offset = s.conversations.filter((c) => !c.isFeishu).length;
        set({ loadingMoreConversations: true });
        try {
          const r = await api.chat.listConversations({ limit: CONV_PAGE, offset });
          set((cur) => {
            // 去重追加(防御 offset 翻页期间列表抖动导致的重叠)。
            const have = new Set(cur.conversations.map((c) => c.id));
            const fresh = r.items.filter((c) => !have.has(c.id));
            return { conversations: [...cur.conversations, ...fresh], conversationsHasMore: r.hasMore, loadingMoreConversations: false };
          });
        } catch {
          set({ loadingMoreConversations: false });
        }
      },

      async switchConversation(id) {
        const cur = useChatStore.getState();
        // 只在「重载当前同一会话」且正流式时跳过 —— 别把进行中的草稿冲掉(后台 SSE 刷新走这里)。
        // 切到「另一条」会话则照切:即便上一条还在后台流式,其回调按草稿 id 定向(见各 mutator),
        // 不会污染新视图,所以回复中也能自由切换会话。
        if (id === cur.conversationId && cur.status !== "idle") return;
        const prevId = cur.conversationId;
        const differentConv = id !== prevId; // 后台对同一会话的静默重拉(id 不变)不清空、不闪加载态
        // 单调序号:快速 A→B 切换时,A 的慢响应回来时已不是最新请求 → 丢弃,避免
        // 「URL 指 B、却显示 A」的错位。newConversation 也会自增它以作废在途请求。
        const seq = ++switchSeq;
        // 立即乐观切到目标 id:① 路由守卫 conversationId!==id 转假,不再二次拉取(去重、更快);
        // ② 切到【另一条】会话时清空 messages + 标 switching,视图显示「加载中」而非旧内容或误导空态。
        // switching 还覆盖「失败后重试」(同 id、当前空、上次有 loadError):也该显示加载中而非闪 Hi助手。
        // 但【同一会话的后台静默重拉】(refreshActive:SSE 每次推送对当前会话调本方法,id 不变、无
        // loadError)绝不置 switching —— 否则查看空会话时每来一条推送都会闪加载态并瞬间藏输入框。
        const showLoading = differentConv || (cur.messages.length === 0 && cur.loadError != null);
        set({
          conversationId: id,
          switching: showLoading,
          loadError: null,
          status: "idle",
          // 切到另一条会话:清空 messages,并把标题占位清成中性(避免深链到列表外的会话时,加载
          // 期间顶栏回退显示【上一条】会话的标题);加载成功后由真标题覆盖。
          ...(differentConv ? { messages: [], activeTitle: null, activeIsFeishu: false } : {}),
        });
        let resp: Awaited<ReturnType<typeof api.chat.getConversation>>;
        try {
          resp = await api.chat.getConversation(id, { limit: MSG_PAGE });
        } catch (e) {
          if (seq !== switchSeq) return; // 已被更晚切换/新对话取代 → 忽略这次失败
          // 切到另一条会话失败 → 显式 loadError + 可重试;同会话后台刷新失败 → 静默保留原内容。
          set(differentConv
            ? { switching: false, messages: [], status: "idle", error: null, isThinking: false, loadError: (e as Error).message || tr("error.loadFailed") }
            : { switching: false });
          return;
        }
        if (seq !== switchSeq) return;                          // 被更晚的一次切换/新对话取代
        let messages = hydrateRows(resp.messages);
        // 该会话仍有后台在生成的轮次(切走再切回)→ 末尾补一条「正在回复」占位草稿,
        // 让视图与切走前一致地显示「助手思考中…」(由 ExpertAnswerExtras 按 trace 渲染),
        // 而不是干巴巴的 loading 三点。答复落库后 onDone/SSE 重拉会用真消息替换它。
        const rtMap = useChatStore.getState().runtimeByConversation;
        if (rtOf(rtMap, resp.id).generating) {
          const lastTs = messages.length ? new Date(messages[messages.length - 1]!.createdAt).getTime() : Date.now();
          // 该轮仍在后台跑(可能正处于助手门控、或已分诊到专家——切回时无从得知具体阶段),
          // 故统一显示「助手思考中…」(routed roleIds=[]):与发送时的初始态一致,落库后由
          // 真消息的权威 trace 替换。底部「已选专家」由 targets 恢复(见下方),与此处状态相互独立。
          messages = [...messages, {
            id: `tmp-bg-${resp.id}`,
            role: "assistant",
            content: "",
            citedArticleIds: [],
            citedRefs: [],
            mentions: [],
            createdAt: new Date(lastTs + 1).toISOString(),
            trace: [{ type: "routed", roleIds: [] }], // → streamingStatus 显示「助手思考中…」
          }];
        }
        set({
          conversationId: resp.id,
          // 刷新后重建 doc 出处芯片(citedRefs→citations,见 hydrateRows)。
          messages,
          hasMoreOlder: resp.hasMoreOlder,
          loadingOlder: false,
          switching: false,
          status: "idle",
          error: null,
          loadError: null, // 成功加载 → 清除上次的加载错误
          isThinking: false, // 切换清思考态,避免上一会话的 thinking 徽标泄漏到新视图
          summary: resp.summary,
          summaryUpToMessageId: resp.summaryUpToMessageId,
          activeTitle: resp.title ?? null,
          activeIsFeishu: resp.isFeishu ?? false,
          // 切到「另一条」会话:恢复该会话此前记住的已选专家(没有则空),不再无条件清空——
          // 这样切走再切回时底部选择条仍显示原来选中的专家。后台对当前会话的静默重拉
          // (refreshActive,id 不变)不动 targets,以免覆盖用户正在编排的选择。
          ...(resp.id !== prevId ? { targets: rtOf(rtMap, resp.id).targets } : {}),
        });
      },

      newConversation() {
        // 作废在途的 switchConversation:否则其慢响应回来时 seq 仍等于 switchSeq,会把上一条会话的
        // 历史灌进「新对话」空态视图 —— 正是「点新对话却显示上一条历史」的错位根因。
        ++switchSeq;
        abortRegistry.delete(NEW_KEY);
        set((s) => ({
          conversationId: null, messages: [], targets: [],
          summary: null, summaryUpToMessageId: null,
          hasMoreOlder: false, loadingOlder: false, switching: false, status: "idle", error: null, loadError: null,
          activeTitle: null, activeIsFeishu: false, isThinking: false,
          // 清掉上一条「新对话」(NEW_KEY)遗留的运行态(草稿/选择/生成中),进全新空态。
          runtimeByConversation: dropRt(s.runtimeByConversation, NEW_KEY),
        }));
      },

      setActiveConversationId(id) {
        // 新对话首发拿到真 id:把 NEW_KEY 下的运行态(已选专家 / 草稿 / generating)整体迁移到真 id,
        // 中止句柄同迁 → 切走再切回这条新会话也能恢复选择 / 占位 / 停止。
        const ac = abortRegistry.get(NEW_KEY);
        if (ac) { abortRegistry.set(id, ac); abortRegistry.delete(NEW_KEY); }
        set((s) => {
          const fromNew = s.runtimeByConversation[NEW_KEY];
          if (!fromNew) return { conversationId: id };
          const existing = rtOf(s.runtimeByConversation, id);
          const merged = { ...existing, ...fromNew, generating: existing.generating || fromNew.generating };
          return { conversationId: id, runtimeByConversation: dropRt({ ...s.runtimeByConversation, [id]: merged }, NEW_KEY) };
        });
      },

      beginGenerating(conversationId) {
        set((s) => (rtOf(s.runtimeByConversation, conversationId).generating
          ? s
          : { runtimeByConversation: patchRt(s.runtimeByConversation, conversationId, { generating: true }) }));
      },

      endGenerating(conversationId) {
        abortRegistry.delete(conversationId);
        set((s) => (rtOf(s.runtimeByConversation, conversationId).generating
          ? { runtimeByConversation: patchRt(s.runtimeByConversation, conversationId, { generating: false }) }
          : s));
      },

      registerAbort(conversationId, ac) {
        abortRegistry.set(conversationId, ac);
      },

      endTurn(conversationId, ac) {
        // 收尾本轮(done/error/finally 调):仅当该会话登记的句柄仍是本轮的 ac 才清 —— 停止后
        // 秒发同会话下一轮已把 registry 换成新 ac,本轮迟到的收尾不能误清新轮的 generating/句柄。
        if (abortRegistry.get(conversationId) !== ac) return;
        abortRegistry.delete(conversationId);
        set((s) => (rtOf(s.runtimeByConversation, conversationId).generating
          ? { runtimeByConversation: patchRt(s.runtimeByConversation, conversationId, { generating: false }) }
          : s));
      },

      abortConversation(conversationId) {
        abortRegistry.get(conversationId)?.abort();
        abortRegistry.delete(conversationId);
        set((s) => ({ runtimeByConversation: patchRt(s.runtimeByConversation, conversationId, { generating: false }) }));
        const st = useChatStore.getState();
        if (activeKey(st.conversationId) !== conversationId) return; // 非当前视图 → 只清标记/句柄
        if (st.status === "sending" || st.status === "streaming") {
          st.stopChat(); // 前台轮:就地清理(⚠ + 丢空草稿 + idle),保留已流式的部分
        } else {
          // 后台轮:停掉「思考中」占位并 idle。【不立即重拉】—— 服务端落部分输出是异步的
          // (req close→SIGTERM→persist),此刻重拉会与之竞态、让部分答复一闪而过;改为下次
          // 进入该会话时由 switchConversation 重拉呈现,避免抖动。
          set((s) => ({ messages: s.messages.filter((m) => m.id !== `tmp-bg-${conversationId}`), status: "idle" }));
        }
      },

      forgetConversation(conversationId) {
        abortRegistry.delete(conversationId);
        set((s) => (conversationId in s.runtimeByConversation
          ? { runtimeByConversation: dropRt(s.runtimeByConversation, conversationId) }
          : s));
      },

      setComposerDraft(html, images) {
        set((s) => ({ runtimeByConversation: patchRt(s.runtimeByConversation, activeKey(s.conversationId), { composerHtml: html, composerImages: images }) }));
      },

      async hydrate() {
        // 初始装载(AiBubble 用):先拉列表,再切到最近一条「普通」会话(无则进空态)。
        // 跳过常驻置顶的飞书会话 —— 它永远排在 conversations[0],但浮窗气泡是通用助手,
        // 不应默认落进飞书专用会话(否则气泡里发的消息会混进飞书会话)。发送中不打断。
        if (useChatStore.getState().status !== "idle") return;
        await useChatStore.getState().loadConversations();
        if (useChatStore.getState().status !== "idle") return;
        const firstNormal = useChatStore.getState().conversations.find((c) => !c.isFeishu);
        if (firstNormal) await useChatStore.getState().switchConversation(firstNormal.id);
        else useChatStore.getState().newConversation();
      },

      async loadOlder() {
        const s = useChatStore.getState();
        if (!s.conversationId || !s.hasMoreOlder || s.loadingOlder || s.messages.length === 0) return;
        // 游标必须是已持久化消息;乐观草稿(tmp-*)不能当 before(后端按会话校验会落空、
        // 退化成返回最新页,造成重复/抖动)。取第一条非 tmp 的消息。
        const oldest = s.messages.find((m) => !m.id.startsWith("tmp-"));
        if (!oldest) return;
        set({ loadingOlder: true });
        try {
          const resp = await api.chat.getConversation(s.conversationId, { before: oldest.id, limit: MSG_PAGE });
          set((cur) => {
            // 去重防御:极端并发下可能与已有重叠,按 id 过滤掉已存在的。
            const have = new Set(cur.messages.map((m) => m.id));
            const older = hydrateRows(resp.messages).filter((m) => !have.has(m.id));
            return { messages: [...older, ...cur.messages], hasMoreOlder: resp.hasMoreOlder, loadingOlder: false };
          });
        } catch {
          set({ loadingOlder: false });
        }
      },

      remoteStart(content, images) {
        set((s) => {
          if (s.status !== "idle") return s;
          const now = new Date().toISOString();
          const userDraft: ChatMessageRow = {
            id: `tmp-ru-${Date.now()}`,
            role: "user",
            content,
            citedArticleIds: [],
            citedRefs: [],
            mentions: [],
            images: images ?? [],
            createdAt: now,
          };
          const assistantDraft: ChatMessageRow = {
            id: `tmp-ra-${Date.now()}`,
            role: "assistant",
            content: "",
            citedArticleIds: [],
            citedRefs: [],
            mentions: [],
            createdAt: now,
          };
          return {
            messages: [...s.messages, userDraft, assistantDraft],
            status: "streaming",
            remoteStreaming: true,
            error: null,
          };
        });
      },

      remoteFinish() {
        set((s) => {
          if (!s.remoteStreaming) return s;
          return { status: "idle", remoteStreaming: false, isThinking: false };
        });
      },

      appendUser(content, mentions, images) {
        const draft: ChatMessageRow = {
          id: `tmp-u-${Date.now()}`,
          role: "user",
          content,
          citedArticleIds: [],
          citedRefs: [],
          mentions: mentions ?? [],
          images: images ?? [],
          createdAt: new Date().toISOString(),
        };
        set((s) => ({ messages: [...s.messages, draft], status: "sending" }));
      },

      beginAssistant() {
        const draft: ChatMessageRow = {
          id: `tmp-a-${Date.now()}`,
          role: "assistant",
          content: "",
          citedArticleIds: [],
          citedRefs: [],
          mentions: [],
          createdAt: new Date().toISOString(),
        };
        set((s) => ({ messages: [...s.messages, draft], status: "streaming" }));
      },

      setTargets(fn) {
        // 顶层 targets 是「活动会话」的镜像;真源是 runtime entry。写两处保持一致:
        // 新对话记在 NEW_KEY 下,首发拿到真 id 由 setActiveConversationId 迁移 → 切走再切回能恢复。
        set((s) => {
          const targets = fn(s.targets);
          return { targets, runtimeByConversation: patchRt(s.runtimeByConversation, activeKey(s.conversationId), { targets }) };
        });
      },

      beginAssistantExpert(targets) {
        // 唯一草稿 id(含单调序号:同毫秒并发的两轮也不撞),供后续写入按 id 定向。
        const draftId = `tmp-a-${Date.now()}-${++draftSeq}`;
        set((s) => {
          // 立即起手时,user 与 assistant 两条草稿常落在同一毫秒 → createdAt 相等,
          // 列表按 (createdAt, id) 排序时 "tmp-a..." < "tmp-u..." 会把回答排到提问上面。
          // 故 assistant 的 createdAt 取「严格晚于上一条」,保证顺序稳定(提问在上,回答在下)。
          const lastTs = s.messages.length ? new Date(s.messages[s.messages.length - 1].createdAt).getTime() : 0;
          const ts = Math.max(Date.now(), lastTs + 1);
          const draft: UiChatMessage = {
            id: draftId,
            role: "assistant",
            content: "",
            citedArticleIds: [],
            citedRefs: [],
            mentions: [],
            createdAt: new Date(ts).toISOString(),
            targets,
            trace: [],
          };
          return { messages: [...s.messages, draft], status: "streaming", error: null };
        });
        return draftId;
      },

      appendAssistantStep(event, messageId) {
        set((s) => {
          const idx = targetAssistantIndex(s.messages, messageId);
          if (idx < 0) return s; // 草稿已不在当前视图(切走了)→ 丢弃
          const next = [...s.messages];
          next[idx] = { ...next[idx], trace: [...(next[idx].trace ?? []), event] };
          return { messages: next };
        });
      },

      finishAssistantExpert(result, messageId) {
        set((s) => {
          const idx = targetAssistantIndex(s.messages, messageId);
          if (idx < 0) return s; // 草稿不在视图 → 不动消息、也不改 status(别误把别的会话置 idle)
          const next = [...s.messages];
          next[idx] = {
            ...next[idx],
            content: result.answer,
            trace: result.trace,
            citations: result.citations,
            escalation: result.escalation,
            ...(result.images?.length ? { images: result.images } : {}), // AI 生成的图片
            // 生图场景:服务端把「讲思路」叙述归入 thinking、answer 留空 → 正文只剩图,叙述进「思考过程」折叠区。
            // (流式时叙述曾以 token 进 content;此处 content 被 answer="" 覆盖清掉,叙述移到 thinking。)
            ...(result.thinking ? { thinking: result.thinking } : {}),
          };
          // 清思考态:思考文本留在消息上(可展开),但停止「深度思考中」脉冲。
          return { messages: next, status: "idle", error: null, isThinking: false };
        });
      },

      failAssistantExpert(message, messageId) {
        set((s) => {
          const idx = targetAssistantIndex(s.messages, messageId);
          if (idx < 0) return s; // 草稿不在视图 → no-op
          const next = [...s.messages];
          next[idx] = { ...next[idx], content: next[idx].content || tr("shell.chat.error", { message }) };
          return { messages: next, status: "idle", error: null, isThinking: false };
        });
      },

      markEscalationHandled(messageId) {
        set((s) => ({
          messages: s.messages.map((m) => (m.id === messageId ? { ...m, escalationHandled: true } : m)),
        }));
      },

      appendAssistantToken(text, messageId) {
        set((s) => {
          const idx = targetAssistantIndex(s.messages, messageId);
          if (idx < 0) return s; // 草稿不在视图(切走了)→ 丢弃,不污染当前会话
          const next = [...s.messages];
          next[idx] = { ...next[idx], content: next[idx].content + text };
          return { messages: next };
        });
      },

      appendAssistantThinking(text, messageId) {
        set((s) => {
          const next = [...s.messages];
          let idx: number;
          if (messageId !== undefined) {
            // 统一/专家路径:定向到本轮草稿;切走了(不在视图)→ 丢弃,不污染当前会话。
            idx = targetAssistantIndex(s.messages, messageId);
            if (idx < 0) return s;
          } else {
            // 旧路径:沿用「最后一条 assistant」,并在思考先于首 token 到达时惰性建占位。
            idx = next.length - 1;
            if (idx < 0 || next[idx].role !== "assistant") {
              const draft: ChatMessageRow = {
                id: `tmp-a-${Date.now()}`,
                role: "assistant",
                content: "",
                citedArticleIds: [],
                citedRefs: [],
                mentions: [],
                createdAt: new Date().toISOString(),
              };
              next.push(draft);
              idx = next.length - 1;
            }
          }
          // Seed thinking with "" on the first event (text === "") so
          // we can later distinguish "no thinking" (undefined) from
          // "thinking with no surfaced text". Subsequent non-empty
          // deltas concatenate.
          // text==="" 是「开始一段新思考」的信号:若前面已有思考内容,插入空行分隔,
          // 让多次思考(模型分多个 thinking 块)在卡片里按段展示,而不是糊成一坨。
          const prev = next[idx].thinking ?? "";
          const sep = text === "" && prev !== "" && !prev.endsWith("\n\n") ? "\n\n" : "";
          next[idx] = { ...next[idx], thinking: prev + sep + text };
          // Only patch isThinking when it actually transitions, to
          // avoid waking every isThinking subscriber on each delta
          // (long thinking traces emit many; without this guard the
          // header / card re-renders on every chunk for no reason).
          // status is similarly idempotent — Zustand short-circuits
          // when the next state object's keys match, but we mirror
          // the same intent by only patching what changed.
          if (s.isThinking && s.status === "streaming") {
            return { messages: next };
          }
          return { messages: next, status: "streaming", isThinking: true };
        });
      },

      endAssistantThinking() {
        set({ isThinking: false });
      },

      setAssistantRefs(refs) {
        set((s) => {
          const next = [...s.messages];
          const last = next[next.length - 1];
          if (!last || last.role !== "assistant") return s;
          next[next.length - 1] = { ...last, citedRefs: refs };
          return { messages: next };
        });
      },

      finishAssistant(citedArticleIds) {
        set((s) => {
          const next = [...s.messages];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, citedArticleIds };
          // Defensive: clear isThinking on done in case the server's
          // thinking_end event got dropped (network truncation,
          // out-of-order delivery, etc). Otherwise the badge could
          // stay pulsing forever after the answer landed.
          return { messages: next, status: "idle", error: null, isThinking: false };
        });
      },

      setError(message) {
        set({ status: "error", error: message, isThinking: false });
      },

      stopChat() {
        set((s) => {
          // Race guard: if the turn already completed (status flipped
          // to idle via a `done` event that landed just before the
          // user's click), do nothing. Without this we'd mark the
          // just-completed user message as aborted, putting a false
          // ⚠ next to a fully-answered question. The stop button is
          // rendered when `disabled === true` (sending/streaming), so
          // by the time onStop runs status could have already moved
          // on within the same React tick.
          if (s.status !== "sending" && s.status !== "streaming") return s;
          // Walk from the end and mark the most recent USER message
          // aborted. We stop at the first user we find — earlier
          // user messages (from prior completed turns) aren't part
          // of THIS abort, so they keep their unmarked state.
          const next = s.messages.slice();
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "user") {
              next[i] = { ...next[i], aborted: true };
              break;
            }
          }
          // Drop a trailing empty assistant placeholder if the abort
          // landed before any token / thinking text. With content,
          // we keep it — the user already saw a partial reply and
          // removing it would feel like the answer disappeared.
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && last.content === "" && (last.thinking === undefined || last.thinking === "")) {
            next.pop();
          }
          return { messages: next, status: "idle", error: null, isThinking: false };
        });
      },

      async reset() {
        const id = useChatStore.getState().conversationId;
        if (id) await api.chat.clearConversation(id);
        const key = activeKey(id);
        abortRegistry.delete(key);
        // Server clears summary state on DELETE too; mirror that here
        // so the UI doesn't briefly show a stale [此前对话摘要] fold.
        set((s) => ({
          messages: [], status: "idle", error: null, loadError: null, switching: false, summary: null, summaryUpToMessageId: null, isThinking: false, targets: [], hasMoreOlder: false, loadingOlder: false,
          // 清掉当前会话的全部运行态(整段对话已清空)。
          runtimeByConversation: dropRt(s.runtimeByConversation, key),
        }));
      },
    }),
    {
      name: "tm.ws.chat.ui",
      // Persist only the surface preferences (pin + bubble position).
      // `isOpen` is intentionally NOT persisted — the AI panel should
      // always start CLOSED on a fresh page load so a user who hit
      // "open" once during a previous session isn't pop-up-bombed
      // every time they navigate back to the app. We still keep it
      // in the live store, just not in localStorage.
      partialize: (state) => ({
        isPinned: state.isPinned,
        bubblePos: state.bubblePos,
      }) as Partial<ChatStore>,
      // Older builds wrote `isOpen` into the same key; strip it on
      // rehydration so a stale `isOpen: true` doesn't auto-open the
      // panel on the user's next load before the new partialize takes
      // hold.
      merge: (persisted, current) => {
        const sanitized = { ...(persisted as Record<string, unknown> | undefined) };
        delete sanitized.isOpen;
        return { ...current, ...sanitized } as ChatStore;
      },
    },
  ),
);
