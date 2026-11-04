import { describe, it, expect, beforeEach, vi } from "vitest";

// chat.ts 在 reset() 里调 api.chat.clearConversation();loadOlder/switchConversation 调 getConversation;
// hydrate/loadConversations 调 listConversations。用 vi.hoisted 让 mock 工厂引用同一组可控 spy。
const { getConversation, listConversations } = vi.hoisted(() => ({ getConversation: vi.fn(), listConversations: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { chat: { clearConversation: vi.fn(async () => {}), getConversation, listConversations } },
}));

import { useChatStore } from "./chat";
import type { ExpertChatResult } from "@/lib/api";
import type { ChatMessageRow } from "@team-knowledge/shared";

beforeEach(() => {
  useChatStore.setState({ messages: [], status: "idle", error: null, targets: [] });
});

describe("chat store · 专家轮次", () => {
  it("setTargets 增删选中专家", () => {
    useChatStore.getState().setTargets((t) => [...t, "r1"]);
    useChatStore.getState().setTargets((t) => [...t, "r2"]);
    expect(useChatStore.getState().targets).toEqual(["r1", "r2"]);
    useChatStore.getState().setTargets((t) => t.filter((x) => x !== "r1"));
    expect(useChatStore.getState().targets).toEqual(["r2"]);
  });

  it("beginAssistantExpert 播种 trace:[] 与 targets,标记 streaming", () => {
    useChatStore.getState().appendUser("问产品", [], []);
    useChatStore.getState().beginAssistantExpert(["r1"]);
    const last = useChatStore.getState().messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.trace).toEqual([]);          // 专家轮次判别标志
    expect(last.targets).toEqual(["r1"]);
    expect(useChatStore.getState().status).toBe("streaming");
  });

  it("beginAssistantExpert 的 createdAt 严格晚于上一条(同毫秒也不会把回答排到提问上面)", () => {
    useChatStore.getState().appendUser("hello", [], []);
    const user = useChatStore.getState().messages.at(-1)!;
    useChatStore.getState().beginAssistantExpert([]);
    const asst = useChatStore.getState().messages.at(-1)!;
    expect(new Date(asst.createdAt).getTime()).toBeGreaterThan(new Date(user.createdAt).getTime());
  });

  it("appendAssistantStep 累计 trace;appendAssistantToken 累计正文", () => {
    useChatStore.getState().beginAssistantExpert([]);
    useChatStore.getState().appendAssistantStep({ type: "routed", roleIds: [] });
    useChatStore.getState().appendAssistantToken("你");
    useChatStore.getState().appendAssistantToken("好");
    const last = useChatStore.getState().messages.at(-1)!;
    expect(last.trace).toHaveLength(1);
    expect(last.content).toBe("你好");
  });

  it("finishAssistantExpert 写 answer/citations/trace/escalation 并 idle", () => {
    useChatStore.getState().beginAssistantExpert(["r1"]);
    const result: ExpertChatResult = {
      answer: "最终答复", trace: [{ type: "answered", roleId: "r1" }],
      citations: [{ source: "doc", title: "X", ref: "a1" }],
      conversationId: "c1",
      escalation: { id: "e1", roleId: "r1", background: "b", question: "q", options: ["甲"] },
    };
    useChatStore.getState().finishAssistantExpert(result);
    const last = useChatStore.getState().messages.at(-1)!;
    expect(last.content).toBe("最终答复");
    expect(last.citations).toHaveLength(1);
    expect(last.escalation?.id).toBe("e1");
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("回复中切换会话:后台轮次按草稿 id 定向,不污染切到的新会话", async () => {
    // A 会话起手一轮(拿到草稿 id),开始流式。
    useChatStore.setState({ messages: [], status: "idle", conversationId: "A" });
    const draftId = useChatStore.getState().beginAssistantExpert([]);
    useChatStore.getState().appendAssistantToken("A-部分", draftId);
    expect(useChatStore.getState().status).toBe("streaming");

    // 切到 B 会话(模拟 switchConversation 的结果):换成 B 的消息、idle。
    useChatStore.setState({
      conversationId: "B",
      messages: [{ id: "b1", role: "user", content: "B 的问题", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "x" } as ChatMessageRow],
      status: "idle",
    });

    // A 的后台流式继续到达 —— 必须全部落空,不能写进 B。
    useChatStore.getState().appendAssistantToken("A-更多", draftId);
    useChatStore.getState().appendAssistantStep({ type: "routed", roleIds: [] }, draftId);
    useChatStore.getState().finishAssistantExpert(
      { answer: "A-终稿", trace: [], citations: [], conversationId: "A" }, draftId,
    );

    const st = useChatStore.getState();
    expect(st.conversationId).toBe("B");
    expect(st.messages.map((m) => m.id)).toEqual(["b1"]);   // B 视图未被污染
    expect(st.messages[0]!.content).toBe("B 的问题");
    expect(st.status).toBe("idle");                          // A 收尾没把 B 误置 idle/streaming
  });

  it("beginGenerating / endGenerating:按会话维护 runtime.generating(幂等)", () => {
    useChatStore.setState({ runtimeByConversation: {} });
    useChatStore.getState().beginGenerating("A");
    useChatStore.getState().beginGenerating("A"); // 重复不变
    useChatStore.getState().beginGenerating("B");
    expect(useChatStore.getState().runtimeByConversation.A!.generating).toBe(true);
    expect(useChatStore.getState().runtimeByConversation.B!.generating).toBe(true);
    useChatStore.getState().endGenerating("A");
    expect(useChatStore.getState().runtimeByConversation.A!.generating).toBe(false);
    expect(useChatStore.getState().runtimeByConversation.B!.generating).toBe(true);
  });

  it("markEscalationHandled 标记对应消息;reset 清 targets", async () => {
    useChatStore.getState().beginAssistantExpert(["r1"]);
    const id = useChatStore.getState().messages.at(-1)!.id;
    useChatStore.getState().markEscalationHandled(id);
    expect(useChatStore.getState().messages.at(-1)!.escalationHandled).toBe(true);
    useChatStore.setState({ targets: ["r1"] });
    await useChatStore.getState().reset();
    expect(useChatStore.getState().targets).toEqual([]);
  });
});

describe("chat store · 分页 loadOlder", () => {
  beforeEach(() => {
    getConversation.mockReset();
    useChatStore.setState({ messages: [], status: "idle", error: null, targets: [], hasMoreOlder: false, loadingOlder: false, conversationId: "c1" });
  });

  const row = (id: string): ChatMessageRow => ({
    id, role: "assistant", content: id, citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:00Z",
  });

  it("loadOlder:把更早一页 prepend 到最前并更新 hasMoreOlder", async () => {
    useChatStore.setState({ messages: [row("m10"), row("m11")], hasMoreOlder: true });
    getConversation.mockResolvedValue({ id: "c1", messages: [row("m08"), row("m09")], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await useChatStore.getState().loadOlder();
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m08", "m09", "m10", "m11"]);
    expect(useChatStore.getState().hasMoreOlder).toBe(false);
    expect(getConversation).toHaveBeenCalledWith("c1", { before: "m10", limit: 40 });
  });

  it("loadOlder:hasMoreOlder=false 或加载中 → 不请求", async () => {
    useChatStore.setState({ messages: [row("m10")], hasMoreOlder: false });
    await useChatStore.getState().loadOlder();
    expect(getConversation).not.toHaveBeenCalled();
  });
});

describe("chat store · 多任务对话", () => {
  beforeEach(() => {
    getConversation.mockReset();
    listConversations.mockReset();
    useChatStore.setState({ messages: [], status: "idle", error: null, loadError: null, switching: false, targets: [], conversations: [], conversationId: null, runtimeByConversation: {} });
  });

  const row = (id: string): ChatMessageRow => ({
    id, role: "user", content: id, citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:00Z",
  });

  it("switchConversation:切到目标会话并重载消息", async () => {
    getConversation.mockResolvedValueOnce({
      id: "c2", messages: [row("m1")],
      summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false,
    });
    await useChatStore.getState().switchConversation("c2");
    expect(useChatStore.getState().conversationId).toBe("c2");
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1"]);
    expect(getConversation).toHaveBeenCalledWith("c2", { limit: 40 });
  });

  it("switchConversation:拉取失败 → 记 loadError(不静默留空态),成功重试后清空", async () => {
    // 加载失败(服务端抖动):不再把异常 void 吞掉留下误导空态,而是显式记 loadError 且切到该会话。
    getConversation.mockRejectedValueOnce(new Error("boom"));
    await useChatStore.getState().switchConversation("c2");
    expect(useChatStore.getState().conversationId).toBe("c2");
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().loadError).toBe("boom");
    // 重试成功 → loadError 清空,消息填充。
    getConversation.mockResolvedValueOnce({
      id: "c2", messages: [row("m1")],
      summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false,
    });
    await useChatStore.getState().switchConversation("c2");
    expect(useChatStore.getState().loadError).toBeNull();
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("newConversation 作废在途 switchConversation:慢响应不再灌进新对话空态(修错位)", async () => {
    // 模拟慢加载:switchConversation 起了 fetch 但迟迟不 resolve。
    let resolveGet!: (v: unknown) => void;
    getConversation.mockImplementationOnce(() => new Promise((res) => { resolveGet = res; }));
    const pending = useChatStore.getState().switchConversation("F");
    // 乐观切:已切到 F 且 switching。
    expect(useChatStore.getState().conversationId).toBe("F");
    expect(useChatStore.getState().switching).toBe(true);
    // 期间点「新对话」→ 应作废在途请求(bump switchSeq)。
    useChatStore.getState().newConversation();
    expect(useChatStore.getState().conversationId).toBeNull();
    expect(useChatStore.getState().switching).toBe(false);
    // F 的慢响应现在才回来 → 必须被丢弃,不得把 F 的历史灌进新对话空态。
    resolveGet({ id: "F", messages: [row("mF")], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await pending;
    expect(useChatStore.getState().conversationId).toBeNull(); // 仍是新对话
    expect(useChatStore.getState().messages).toEqual([]);      // 未被 F 污染
  });

  it("同会话后台重拉(无 loadError)不置 switching:查看空会话时 SSE 推送不闪加载态", async () => {
    // refreshActive 会对当前会话调 switchConversation(同 id);查看空会话且无 loadError 时不该闪加载态。
    useChatStore.setState({ conversationId: "c1", messages: [], status: "idle", loadError: null, switching: false });
    let resolveGet!: (v: unknown) => void;
    getConversation.mockImplementationOnce(() => new Promise((res) => { resolveGet = res; }));
    const p = useChatStore.getState().switchConversation("c1");
    expect(useChatStore.getState().switching).toBe(false); // 后台重拉不置 switching(不藏输入框)
    resolveGet({ id: "c1", messages: [row("m1")], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await p;
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("切回后台生成中的会话:补「正在回复」占位草稿(显示 AI 思考中,而非 loading 三点)", async () => {
    useChatStore.setState({ conversationId: "other", runtimeByConversation: { c2: { generating: true, targets: [], composerHtml: "", composerImages: [] } } });
    getConversation.mockResolvedValueOnce({
      id: "c2", messages: [row("u1")],
      summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false,
    });
    await useChatStore.getState().switchConversation("c2");
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(2);                       // 问题 + 占位草稿
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("");
    expect(last.trace).toEqual([{ type: "routed", roleIds: [] }]); // → streamingStatus「AI 思考中…」
  });

  it("切走再切回:恢复该会话此前选中的专家(底部选择条不丢)", async () => {
    // 在 c1 选了专家 r1 → 记入该会话记忆。
    useChatStore.setState({ conversationId: "c1" });
    useChatStore.getState().setTargets(() => ["r1"]);
    expect(useChatStore.getState().runtimeByConversation.c1!.targets).toEqual(["r1"]);
    // 切到 c2 → 当前选择清空(不带到别的会话)。
    getConversation.mockResolvedValueOnce({ id: "c2", messages: [], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await useChatStore.getState().switchConversation("c2");
    expect(useChatStore.getState().targets).toEqual([]);
    // 切回 c1 → 恢复 r1。
    getConversation.mockResolvedValueOnce({ id: "c1", messages: [], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await useChatStore.getState().switchConversation("c1");
    expect(useChatStore.getState().targets).toEqual(["r1"]);
  });

  it("forgetConversation:删除会话清掉其 runtime entry(免孤儿残留)", () => {
    useChatStore.setState({ runtimeByConversation: {
      c1: { generating: true, targets: ["r1"], composerHtml: "", composerImages: [] },
      c2: { generating: false, targets: ["r2"], composerHtml: "", composerImages: [] },
    } });
    useChatStore.getState().forgetConversation("c1");
    expect(useChatStore.getState().runtimeByConversation.c1).toBeUndefined();
    expect(useChatStore.getState().runtimeByConversation.c2!.targets).toEqual(["r2"]);
    // 无痕迹的会话:幂等,不报错。
    useChatStore.getState().forgetConversation("nope");
    expect(Object.keys(useChatStore.getState().runtimeByConversation)).toEqual(["c2"]);
  });

  it("setActiveConversationId:新对话 NEW_KEY 运行态整体迁移到真 id", () => {
    useChatStore.setState({ conversationId: null, runtimeByConversation: {} });
    useChatStore.getState().setTargets(() => ["r1"]); // 记在 NEW_KEY ""
    useChatStore.getState().beginGenerating("");        // 记在 NEW_KEY ""
    expect(useChatStore.getState().runtimeByConversation[""]!.targets).toEqual(["r1"]);
    useChatStore.getState().setActiveConversationId("real1");
    const rt = useChatStore.getState().runtimeByConversation;
    expect(rt[""]).toBeUndefined();          // NEW_KEY 已迁走
    expect(rt.real1!.targets).toEqual(["r1"]);
    expect(rt.real1!.generating).toBe(true); // generating 也随迁
    expect(useChatStore.getState().conversationId).toBe("real1");
  });

  it("abortConversation:中止该会话登记的句柄 + 清 generating(前台轮就地停)", () => {
    const ac = new AbortController();
    const spy = vi.spyOn(ac, "abort");
    useChatStore.setState({
      conversationId: "c1", status: "streaming",
      messages: [
        { id: "u1", role: "user", content: "q", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:00Z" },
        { id: "tmp-a", role: "assistant", content: "", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:01Z", trace: [] },
      ],
      runtimeByConversation: { c1: { generating: true, targets: [], composerHtml: "", composerImages: [] } },
    });
    useChatStore.getState().registerAbort("c1", ac);
    useChatStore.getState().abortConversation("c1");
    expect(spy).toHaveBeenCalled();                                  // 句柄被中止
    expect(useChatStore.getState().runtimeByConversation.c1!.generating).toBe(false);
    expect(useChatStore.getState().status).toBe("idle");            // stopChat 收尾
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["u1"]); // 空占位被丢弃
    expect(useChatStore.getState().messages[0]!.aborted).toBe(true); // user 标记中断
  });

  it("abortConversation(后台轮):丢掉「思考中」占位 + idle,不立即重拉(避免与落库竞态)", () => {
    const ac = new AbortController();
    const spy = vi.spyOn(ac, "abort");
    useChatStore.setState({
      conversationId: "c1", status: "idle", // 后台轮:切回来看,status 已 idle
      messages: [
        { id: "u1", role: "user", content: "q", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:00Z" },
        { id: "tmp-bg-c1", role: "assistant", content: "", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:01Z", trace: [{ type: "routed", roleIds: [] }] },
      ],
      runtimeByConversation: { c1: { generating: true, targets: [], composerHtml: "", composerImages: [] } },
    });
    useChatStore.getState().registerAbort("c1", ac);
    getConversation.mockClear();
    useChatStore.getState().abortConversation("c1");
    expect(spy).toHaveBeenCalled();
    expect(useChatStore.getState().runtimeByConversation.c1!.generating).toBe(false);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["u1"]); // 占位被丢
    expect(useChatStore.getState().status).toBe("idle");
    expect(getConversation).not.toHaveBeenCalled(); // 不立即重拉
  });

  it("endTurn:只清「仍是本轮 ac」的轮次;被秒发的新轮接管则不误清", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    useChatStore.setState({ runtimeByConversation: { c1: { generating: true, targets: [], composerHtml: "", composerImages: [] } } });
    useChatStore.getState().registerAbort("c1", ac1);
    useChatStore.getState().registerAbort("c1", ac2); // 停止后秒发:新轮 ac2 接管
    useChatStore.getState().endTurn("c1", ac1);        // 旧轮迟到收尾 → 不误清
    expect(useChatStore.getState().runtimeByConversation.c1!.generating).toBe(true);
    useChatStore.getState().endTurn("c1", ac2);        // 新轮自己收尾 → 清
    expect(useChatStore.getState().runtimeByConversation.c1!.generating).toBe(false);
  });

  it("setComposerDraft:输入框草稿按会话存,切走切回不丢、不串台", async () => {
    useChatStore.setState({ conversationId: "c1", runtimeByConversation: {} });
    useChatStore.getState().setComposerDraft("草稿 A", []);
    expect(useChatStore.getState().runtimeByConversation.c1!.composerHtml).toBe("草稿 A");
    // 切到 c2 写它自己的草稿 → c1 的草稿不被覆盖。
    getConversation.mockResolvedValueOnce({ id: "c2", messages: [], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await useChatStore.getState().switchConversation("c2");
    useChatStore.getState().setComposerDraft("草稿 B", []);
    expect(useChatStore.getState().runtimeByConversation.c1!.composerHtml).toBe("草稿 A");
    expect(useChatStore.getState().runtimeByConversation.c2!.composerHtml).toBe("草稿 B");
  });

  it("切到非生成中的会话:不补占位草稿(普通重载)", async () => {
    useChatStore.setState({ conversationId: "other", runtimeByConversation: {} });
    getConversation.mockResolvedValueOnce({
      id: "c3", messages: [row("m1")],
      summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false,
    });
    await useChatStore.getState().switchConversation("c3");
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("newConversation:清空到空态、conversationId=null", () => {
    useChatStore.setState({ messages: [row("x")], conversationId: "c1", targets: ["r1"] });
    useChatStore.getState().newConversation();
    expect(useChatStore.getState().conversationId).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().targets).toEqual([]);
  });

  it("loadConversations:写入列表 + hasMore(每页 20 条)", async () => {
    listConversations.mockResolvedValueOnce({ items: [{ id: "c1", title: "甲", isFeishu: false, pinned: false, lastMessageAt: null, createdAt: "x" }], hasMore: true });
    await useChatStore.getState().loadConversations();
    expect(listConversations).toHaveBeenCalledWith({ limit: 20 });
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["c1"]);
    expect(useChatStore.getState().conversationsHasMore).toBe(true);
  });

  it("loadMoreConversations:按非飞书数算 offset,去重追加,更新 hasMore", async () => {
    const item = (id: string, isFeishu = false) => ({ id, title: id, isFeishu, pinned: false, lastMessageAt: null, createdAt: "x" });
    // 第一页:飞书 + c1、c2(非飞书 2 条),hasMore=true
    useChatStore.setState({ conversations: [item("f", true), item("c1"), item("c2")], conversationsHasMore: true, loadingMoreConversations: false });
    listConversations.mockResolvedValueOnce({ items: [item("c2"), item("c3")], hasMore: false }); // c2 重叠 → 去重
    await useChatStore.getState().loadMoreConversations();
    expect(listConversations).toHaveBeenCalledWith({ limit: 20, offset: 2 }); // offset=非飞书条数
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["f", "c1", "c2", "c3"]);
    expect(useChatStore.getState().conversationsHasMore).toBe(false);
    expect(useChatStore.getState().loadingMoreConversations).toBe(false);
  });

  it("loadMoreConversations:无更多 / 加载中 → 不请求", async () => {
    useChatStore.setState({ conversations: [], conversationsHasMore: false, loadingMoreConversations: false });
    await useChatStore.getState().loadMoreConversations();
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("hydrate:列表非空 → 切到首条;空 → 空态", async () => {
    listConversations.mockResolvedValueOnce({ items: [{ id: "c9", title: "x", isFeishu: false, pinned: false, lastMessageAt: null, createdAt: "x" }], hasMore: false });
    getConversation.mockResolvedValueOnce({ id: "c9", messages: [], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false });
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().conversationId).toBe("c9");

    listConversations.mockResolvedValueOnce({ items: [], hasMore: false });
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().conversationId).toBeNull();
  });
});
