import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChatStore } from "@/stores/chat";
import { api, type ExpertSummary } from "@/lib/api";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";
import { ExpertSelectorBar } from "./ExpertSelectorBar";
import { streamUnifiedChat } from "./streamUnifiedChat";
import { toast } from "@/components/Toaster";
import { getAssistantName } from "@/lib/assistantName";

// 首页统一聊天:全走 orchestrate(总台/专家)。与 AiBubble 共享 useChatStore;
// 但 AiBubble 仍走旧 streamChat(/api/chat/message),保住飞书双向 + thinking(后续再退役旧路由)。
export function HomeChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const summary = useChatStore((s) => s.summary);
  const summaryUpToMessageId = useChatStore((s) => s.summaryUpToMessageId);
  const isThinking = useChatStore((s) => s.isThinking);
  const targets = useChatStore((s) => s.targets);
  const hasMoreOlder = useChatStore((s) => s.hasMoreOlder);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const conversationId = useChatStore((s) => s.conversationId);
  // 会话消息拉取失败(常见于服务端抖动/重启):非空时空态显示「加载失败·重试」而非误导的 Hi助手。
  const loadError = useChatStore((s) => s.loadError);
  // 正在切到另一条会话、消息尚未拉回:空态显示「加载中」而非误导的 Hi assistant(有历史的会话不该闪空)。
  const switching = useChatStore((s) => s.switching);
  // 当前活动会话是否有在飞轮次(前台/后台同一处派生)。新对话 id 未定 → 用 ""(store 的 NEW_KEY)。
  const generating = useChatStore((s) => s.runtimeByConversation[s.conversationId ?? ""]?.generating ?? false);
  const [experts, setExperts] = useState<ExpertSummary[]>([]);
  const [selecting, setSelecting] = useState(false); // 多选分享模式(入口在 composer 分享键)
  // 本面板是否仍挂载(在聊天界面)。轮次在后台继续,完成回调据此判断「用户是否还在聊天界面」,
  // 避免在用户已切到文章等其它页面时还强行跳转/塞答复。
  const mountedRef = useRef(true);
  const navigate = useNavigate();

  // 当前查看的会话是否正后台生成(且本视图没有在跑的实时草稿)→ 显示「正在生成回复…」。
  // status 为 streaming/sending 时是本视图自己的实时轮次,走常规打字机,不需要这个提示。
  const bgReplying = generating && status !== "streaming" && status !== "sending";

  useEffect(() => {
    // 会话装载由 HomeChatRoute 按路由驱动;这里只取专家列表(选择条数据)。
    // 失败降级为空(只能走总台),不阻塞。
    void api.agents.list().then((r) => setExperts(r.experts)).catch(() => setExperts([]));
  }, []);

  // 不再在卸载时中止流:一轮回复发起后,即便切到别的会话/页面也让它在后台跑完并落库,
  // 用户切回时能看到答复(中止只保留给输入框旁的「停止」按钮 onStop 主动触发)。
  useEffect(() => () => { mountedRef.current = false; }, []);

  const roleName = (id: string) => experts.find((e) => e.roleId === id)?.name ?? id;

  // 按会话草稿读/写当前活动会话(新对话记在 ""/NEW_KEY,首发迁移到真 id)。用 useCallback 稳定
  // 身份 —— 否则每次流式 token 触发的重渲染都会换 writeDraft → ChatComposer 的 refresh 重建 →
  // compositionend 监听每 token 重订阅(中文输入法末字有丢失风险)。两者只读 getState(),无需依赖。
  const readDraft = useCallback(() => {
    const s = useChatStore.getState();
    return s.runtimeByConversation[s.conversationId ?? ""]?.composerHtml ?? "";
  }, []);
  const writeDraft = useCallback((html: string) => useChatStore.getState().setComposerDraft(html, []), []);

  async function onSend(content: string, mentions: { type: "doc" | "folder" | "role" | "skill"; id: string; label: string }[], images: string[]) {
    const store = useChatStore.getState();
    const picked = store.targets;
    const cid = store.conversationId ?? undefined; // 空 = 新对话,id 由 onMeta 提前落定
    // 本轮所属会话 id:已有会话即 cid;新对话由服务端 meta 事件回传后落定。生成中标记 / 收尾
    // 清理 / 切回重拉都以它为准,这样新对话回复中切走再切回也能识别为同一会话、保持「回复中」。
    let turnConvId = cid;
    store.appendUser(content, mentions, images);
    // 立即起手专家草稿(播种 trace:[]),实时状态行从一开始就显示
    //(非流式 provider 如 codex 在拿到 token 前也有进展反馈)。draftId 把本轮的所有流式写入
    // 定向到这条草稿:用户回复中途切到别的会话时,本轮的 token/done 不会污染新视图,
    // 而是在后台静默完成并落库(回到本会话时由重拉/列表刷新呈现)。
    const draftId = store.beginAssistantExpert(picked);
    // 即刻标记生成中:已有会话记在其 id;新对话记在 ""(NEW_KEY),onMeta 拿到真 id 时整体迁移。
    store.beginGenerating(cid ?? "");
    // 新对话:点发送即跳进「对话」标签的新会话视图(/c/new);onMeta 拿到真 id 再收敛到 /c/:id。
    // WorkspaceEntry 在 / ↔ /c/* 间被 React Router 复用(不重挂),故流式不会被打断。
    if (!cid) navigate("/c/new");
    const ac = new AbortController();
    store.registerAbort(cid ?? "", ac); // 登记中止句柄(新对话先记 "",onMeta 迁移到真 id)
    try {
      await streamUnifiedChat(content, {
        conversationId: cid,
        targetRoleIds: picked.length ? picked : undefined,
        mentions: mentions.map(({ type, id }) => ({ type, id })),
        images,
        articleId: null, // 首页无文档上下文
        signal: ac.signal,
        onMeta: (id) => {
          turnConvId = id;
          const s = useChatStore.getState();
          s.beginGenerating(id); // 标记生成中(新/旧都安全,幂等)→ 切走再切回显示「正在回复」
          if (!cid) {
            // 新对话:落定 id 并把 URL 收敛到 /c/:id(store.conversationId===id → HomeChatRoute 不重拉,
            // 保住正在流式的草稿)。这样它成为「有 id 的会话」,可被切回并识别为生成中。
            s.setActiveConversationId(id);
            navigate(`/c/${id}`, { replace: true });
          }
        },
        onStep: (e) => useChatStore.getState().appendAssistantStep(e, draftId),
        onToken: (t) => useChatStore.getState().appendAssistantToken(t, draftId),
        onThinking: (t) => useChatStore.getState().appendAssistantThinking(t, draftId), // 思考过程 → 草稿的「思考过程」区
        onThinkingEnd: () => useChatStore.getState().endAssistantThinking(), // 思考结束 → 收起脉冲
        onDone: (r) => {
          const store = useChatStore.getState();
          const convId = turnConvId ?? r.conversationId;
          if (convId) store.endTurn(convId, ac); // 先清「生成中」(仅当仍是本轮),免得重拉后还闪提示
          store.finishAssistantExpert(r, draftId);
          // 每轮结束都刷新列表:lastMessageAt 已被后端推进(touchConversation),刷新后当前
          // 会话即按「最近活跃」重排置顶,而不仅是新建首发那次。
          void store.loadConversations();
          if (!mountedRef.current) return; // 用户已离开聊天界面 → 不硬塞答复/跳转,列表里能找到
          const applied = useChatStore.getState().messages.some((m) => m.id === draftId);
          if (!applied && convId && useChatStore.getState().conversationId === convId) {
            // 用户中途切走、此刻正看着这条会话(切回来了):草稿已不在,重拉以显示落库的答复。
            void store.switchConversation(convId);
          }
        },
        onError: (m) => {
          useChatStore.getState().endTurn(turnConvId ?? "", ac); // 仅清本轮(新对话 pre-meta 出错→清 NEW_KEY)
          useChatStore.getState().failAssistantExpert(m, draftId);
          // 只在「出错的这轮正是当前视图」时弹 toast —— 否则用户已切到别的会话,
          // 为后台某会话弹「请求失败」会让人摸不着头脑。
          const onThisView = useChatStore.getState().messages.some((mm) => mm.id === draftId);
          if (mountedRef.current && onThisView) toast.error(m || "请求失败");
        },
      });
    } finally {
      // 兜底:无论 done/error/中止,都清掉本轮的「生成中」标记 + 中止句柄(仅当仍是本轮 ac,
      // 避免误清「停止后秒发」的新轮),避免切回时永远转圈。
      useChatStore.getState().endTurn(turnConvId ?? "", ac);
    }
  }

  const composer = (
    <ChatComposer
      onSend={onSend}
      // 后台仍在为本会话生成时也禁用输入(该会话忙):待回复落定后自动解锁。generating 同时覆盖
      // 前台(streaming/sending)与后台(切回来仍在飞)两种在飞态,口径统一。
      disabled={status === "sending" || status === "streaming" || generating}
      // 切到「新对话」/「助手」/别的会话即自动聚焦输入框 + 回填该会话草稿(conversationId 变化触发)。
      // 新对话时 conversationId 为 null,用固定串区分,使「点新对话」也能触发。
      focusKey={conversationId ?? "new"}
      // 按会话草稿:读/写当前活动会话的 composerHtml(稳定身份,见上方 useCallback)。
      readDraft={readDraft}
      writeDraft={writeDraft}
      // 落地态(无消息)用加大版输入框;进入会话后(有消息)恢复常规尺寸。
      large={messages.length === 0}
      onShare={messages.length > 0 ? () => setSelecting((s) => !s) : undefined}
      shareActive={selecting}
      headerSlot={
        <ExpertSelectorBar
          experts={experts}
          value={targets}
          onChange={(next) => useChatStore.getState().setTargets(() => next)}
        />
      }
      // 在飞(前台或后台)即给「停止」键,切换前后一致。点击=按会话中止那一轮:
      // abortRegistry.get(会话).abort() → SSE fetch 取消 → 服务端 req close → SIGTERM LLM 子进程;
      // 前台轮就地清理(⚠ + 丢空占位 + idle),后台轮重拉服务端已落的部分输出(见 store.abortConversation)。
      onStop={generating ? () => useChatStore.getState().abortConversation(conversationId ?? "") : undefined}
    />
  );

  // 落地态(无任何消息):聊天输入框垂直+水平居中,像主流大模型「新对话」首屏。
  // 一旦发送(appendUser 入列)或进入有历史的会话,即切回「消息列表在上、输入框在下」的常规布局。
  if (messages.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        {/* 整体(标题 + 输入框)较垂直居中再上移 100px,视觉更靠上。 */}
        <div className="w-full max-w-3xl -translate-y-[100px] px-4">
          {switching ? (
            // 切换到另一条会话、消息未回:显示加载中(而非误导的 Hi助手空态或旧内容)。
            <div className="mb-6 flex items-center justify-center gap-2 text-sm text-muted">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-primary" aria-hidden />
              加载对话中…
            </div>
          ) : loadError && conversationId ? (
            // 加载失败:显式提示 + 重试(而不是把拉取失败误当成新对话空态)。重试即再次拉取该会话。
            <div className="mb-6 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted">对话加载失败,请重试({loadError})</p>
              <button
                type="button"
                onClick={() => void useChatStore.getState().switchConversation(conversationId)}
                className="rounded-lg border border-line px-4 py-1.5 text-sm text-fg transition hover:bg-surface"
              >
                重试
              </button>
            </div>
          ) : conversationId ? (
            // 已有会话但暂无消息(如刚建的空会话 / 被清空):不显示 Hi助手新对话品牌页
            //(「点开对话却出现 Hi助手」正是要避免的),给中性提示,输入框仍在、可继续聊。
            <p className="mb-6 text-center text-sm text-muted">这个对话还没有消息,发一条消息开始吧</p>
          ) : (
            // 真正的新对话(conversationId 为空):助手落地页。
            <h2 className="mb-6 text-center font-brand text-[2.75rem] font-bold tracking-tight text-fg">Hi {getAssistantName()}</h2>
          )}
          {/* 加载中/加载失败时不显示输入框(避免在「别的会话」的空壳上误发);新对话与已有空会话给输入框。 */}
          {!switching && !(loadError && conversationId) && composer}
        </div>
      </div>
    );
  }

  return (
    // 无外框:消息与输入框直接落在页面背景上(参考 WorkBuddy),只保留 composer 自身边框。
    // 顶部标题由右区顶栏(RightTopBar)给出(新对话→assistant,进入会话→会话标题),这里不重复页内 header。
    <div className="flex h-full w-full flex-col">
      <ChatMessageList
        messages={messages}
        status={status}
        error={error}
        summary={summary}
        summaryUpToMessageId={summaryUpToMessageId}
        isThinking={isThinking}
        roleName={roleName}
        onEscalationHandled={(id) => useChatStore.getState().markEscalationHandled(id)}
        selecting={selecting}
        onSelectingChange={setSelecting}
        hasMoreOlder={hasMoreOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={() => useChatStore.getState().loadOlder()}
        // 切回一条仍在后台生成的会话:用与实时回复一样的「正在回复」指示(三点),
        // 状态和切走前保持一致;完成后自动重拉答复替换。
        replying={bgReplying}
      />
      {composer}
    </div>
  );
}
