import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AiBubble } from "./AiBubble";
import { useChatStore } from "@/stores/chat";
import { useAiSurface } from "@/stores/aiSurface";

// Coverage for the floating bubble + popover combo that replaced the
// old right-side ChatPanel. We exercise the same hydrate-on-open +
// streamed-response + cited-ids-persisted flow but through the new
// surface shape.

vi.mock("@/lib/api", () => ({
  api: {
    chat: {
      getConversation: vi.fn(async () => ({ id: "c1", messages: [], summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null, hasMoreOlder: false })),
      listConversations: vi.fn(async () => ({ items: [{ id: "c1", title: null, isFeishu: false, pinned: false, lastMessageAt: null, createdAt: "x" }], hasMore: false })),
      clearConversation: vi.fn(async () => undefined),
    },
  },
}));

vi.mock("./useChatStream", () => ({
  streamChat: vi.fn(async (_content: string, h: {
    onCited: (a: string[], r: { n: number; articleId: string; title: string; folderId: string; roleId: string }[]) => void;
    onToken: (t: string) => void;
    onDone: () => void;
  }) => {
    h.onCited(["a1"], [{ n: 1, articleId: "a1", title: "X", folderId: "m", roleId: "r" }]);
    h.onToken("hello ");
    h.onToken("world [#1]");
    h.onDone();
  }),
}));

beforeEach(() => {
  window.localStorage.clear();
  useChatStore.setState({ messages: [], status: "idle", error: null, conversationId: null, isOpen: false });
  useAiSurface.getState().setSuppressed(false);
});

function openBubble() {
  // The bubble's aria-label flips between "打开助手" / "关闭助手"
  // based on open state; match both so the test query stays stable.
  fireEvent.click(screen.getByRole("button", { name: /AI/ }));
}

// The composer is now a contentEditable div with role="textbox" +
// aria-label="向助手提问". JSDOM doesn't simulate native typing
// into contentEditable, so we set textContent + fire `input` to
// trigger ChatComposer's onInput refresh.
function getEditor(): HTMLElement {
  return screen.getByRole("textbox", { name: /向 AI 提问/ });
}
function typeInto(ed: HTMLElement, text: string) {
  ed.textContent = text;
  fireEvent.input(ed);
}

describe("AiBubble", () => {
  it("hydrates conversation on first open", async () => {
    render(<MemoryRouter initialEntries={["/bookmarks"]}><AiBubble /></MemoryRouter>);
    openBubble();
    await waitFor(() => expect(getEditor()).toBeInTheDocument());
  });

  it("sends a message and renders streamed response with citation badge", async () => {
    render(<MemoryRouter initialEntries={["/bookmarks"]}><AiBubble /></MemoryRouter>);
    openBubble();
    await waitFor(() => getEditor());
    const ed = getEditor();
    typeInto(ed, "hi");
    fireEvent.keyDown(ed, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/hello/)).toBeInTheDocument());
    expect(screen.getByText("#1")).toBeInTheDocument();
  });

  it("renders nothing when the surface is suppressed (e.g. automation run detail)", () => {
    useAiSurface.getState().setSuppressed(true);
    render(<MemoryRouter initialEntries={["/automation"]}><AiBubble /></MemoryRouter>);
    // 整块隐藏:连打开助手的气泡按钮都不在,自然也没有输入框。
    expect(screen.queryByRole("button", { name: /AI/ })).not.toBeInTheDocument();
  });

  it("finishAssistant persists cited article ids (regression: no stale closure)", async () => {
    render(<MemoryRouter initialEntries={["/bookmarks"]}><AiBubble /></MemoryRouter>);
    openBubble();
    await waitFor(() => getEditor());
    const ed = getEditor();
    typeInto(ed, "hi");
    fireEvent.keyDown(ed, { key: "Enter" });
    await waitFor(() => expect(useChatStore.getState().status).toBe("idle"));
    const last = useChatStore.getState().messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.citedArticleIds).toEqual(["a1"]);
  });
});
