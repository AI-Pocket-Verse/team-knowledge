import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChatStore } from "@/stores/chat";
import { handleEvent } from "./useChatUpdates";

beforeEach(() => {
  vi.restoreAllMocks();
  useChatStore.setState({
    messages: [], status: "idle", error: null, targets: [],
    conversationId: "c1", remoteStreaming: false,
    conversations: [
      { id: "c1", title: "甲", isFeishu: false, pinned: false, lastMessageAt: null, createdAt: "x" },
      { id: "f", title: null, isFeishu: true, pinned: false, lastMessageAt: null, createdAt: "x" },
    ],
  });
});

describe("useChatUpdates · handleEvent 多会话", () => {
  it("update:刷新列表 + 重拉当前会话(不再无脑切到最近一条)", () => {
    const loadList = vi.spyOn(useChatStore.getState(), "loadConversations").mockResolvedValue();
    const sw = vi.spyOn(useChatStore.getState(), "switchConversation").mockResolvedValue();
    handleEvent("update", "{}");
    expect(loadList).toHaveBeenCalled();
    expect(sw).toHaveBeenCalledWith("c1");
  });

  it("remote_start:不在飞书会话页时不驱动打字机(remoteStreaming 保持 false)", () => {
    const remoteStart = vi.spyOn(useChatStore.getState(), "remoteStart");
    // 当前 conversationId=c1(非飞书)
    handleEvent("remote_start", JSON.stringify({ text: "你好" }));
    expect(remoteStart).not.toHaveBeenCalled();
    expect(useChatStore.getState().remoteStreaming).toBe(false);
  });

  it("remote_start:正看着飞书会话时驱动打字机", () => {
    useChatStore.setState({ conversationId: "f" }); // 切到飞书会话
    handleEvent("remote_start", JSON.stringify({ text: "你好" }));
    expect(useChatStore.getState().remoteStreaming).toBe(true);
  });

  it("remote_done:刷新列表 + 重拉当前会话", () => {
    const loadList = vi.spyOn(useChatStore.getState(), "loadConversations").mockResolvedValue();
    const sw = vi.spyOn(useChatStore.getState(), "switchConversation").mockResolvedValue();
    handleEvent("remote_done", "{}");
    expect(loadList).toHaveBeenCalled();
    expect(sw).toHaveBeenCalledWith("c1");
  });

  it("update:当前会话末条是带 trace 的本地专家终稿 → 只刷列表、跳过重拉(保住 trace)", () => {
    useChatStore.setState({
      status: "idle",
      messages: [{ id: "a1", role: "assistant", content: "答", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "x", trace: [{ type: "answered", roleId: "r1" }] }],
    });
    const loadList = vi.spyOn(useChatStore.getState(), "loadConversations").mockResolvedValue();
    const sw = vi.spyOn(useChatStore.getState(), "switchConversation").mockResolvedValue();
    handleEvent("update", "{}");
    expect(loadList).toHaveBeenCalled();          // 列表照常刷新(排序置顶)
    expect(sw).not.toHaveBeenCalled();            // 但不重拉消息(否则丢 trace)
  });

  it("update:当前会话没有本地 trace 可护(如切回后台生成中的会话)→ 重拉以显示落库答复", () => {
    useChatStore.setState({
      status: "idle",
      messages: [{ id: "u1", role: "user", content: "问", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "x" }],
    });
    const loadList = vi.spyOn(useChatStore.getState(), "loadConversations").mockResolvedValue();
    const sw = vi.spyOn(useChatStore.getState(), "switchConversation").mockResolvedValue();
    handleEvent("update", "{}");
    expect(loadList).toHaveBeenCalled();
    expect(sw).toHaveBeenCalledWith("c1");        // 重拉当前会话
  });
});
