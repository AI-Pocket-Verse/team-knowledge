import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useChatStore } from "@/stores/chat";
import { HomeChatRoute } from "./HomeChatRoute";

// HomeChatPanel 首挂会 hydrate + 拉专家;mock api 避免真实请求。
vi.mock("@/lib/api", () => ({
  api: {
    chat: {
      listConversations: vi.fn(async () => ({ items: [], hasMore: false })),
      getConversation: vi.fn(async () => ({ id: "x", messages: [], summary: null, summaryUpToMessageId: null, hasMoreOlder: false })),
    },
    agents: { list: vi.fn(async () => ({ experts: [] })) },
  },
}));

beforeEach(() => {
  vi.spyOn(useChatStore.getState(), "switchConversation").mockClear().mockResolvedValue(undefined);
  vi.spyOn(useChatStore.getState(), "newConversation").mockClear().mockReturnValue(undefined);
});

describe("HomeChatRoute", () => {
  it("/c/:id → switchConversation(id)", () => {
    render(
      <MemoryRouter initialEntries={["/c/abc"]}>
        <Routes><Route path="/c/:conversationId" element={<HomeChatRoute />} /></Routes>
      </MemoryRouter>,
    );
    expect(useChatStore.getState().switchConversation).toHaveBeenCalledWith("abc");
  });

  it("/c/new → newConversation()", () => {
    render(
      <MemoryRouter initialEntries={["/c/new"]}>
        <Routes><Route path="/c/:conversationId" element={<HomeChatRoute />} /></Routes>
      </MemoryRouter>,
    );
    expect(useChatStore.getState().newConversation).toHaveBeenCalled();
  });

  it("/(首页)→ newConversation()(AI 落地页是新对话空态,不预载最近一条)", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes><Route path="/" element={<HomeChatRoute />} /></Routes>
      </MemoryRouter>,
    );
    expect(useChatStore.getState().newConversation).toHaveBeenCalled();
    // 不应再调用 switchConversation(那是「加载最近一条」的旧行为)
    expect(useChatStore.getState().switchConversation).not.toHaveBeenCalled();
  });
});
