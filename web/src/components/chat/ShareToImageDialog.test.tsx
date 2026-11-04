import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ChatMessageRow } from "@team-knowledge/shared";

vi.mock("@/lib/api", () => ({
  api: { chat: { shareImage: vi.fn() } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));
vi.mock("@/components/Toaster", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from "@/lib/api";
import { ShareToImageDialog, buildChatImagePayload } from "./ShareToImageDialog";

function msg(role: ChatMessageRow["role"], content: string): ChatMessageRow {
  return { id: `m-${content}`, role, content, citedArticleIds: [], citedRefs: [], mentions: [], createdAt: new Date(0).toISOString() };
}

describe("buildChatImagePayload", () => {
  it("maps rows to {role, content, images}, normalizing non-user roles to assistant", () => {
    const payload = buildChatImagePayload([msg("user", "问题"), msg("assistant", "回答")], "标题");
    expect(payload).toEqual({
      title: "标题",
      messages: [
        { role: "user", content: "问题", images: [] },
        { role: "assistant", content: "回答", images: [] },
      ],
    });
  });

  it("carries a message's attached image urls through to the payload", () => {
    const payload = buildChatImagePayload([{ ...msg("user", "看图"), images: ["/uploads/a.png"] }]);
    expect(payload.messages[0]).toEqual({ role: "user", content: "看图", images: ["/uploads/a.png"] });
  });

  it("drops a blank title (server fills the default)", () => {
    expect(buildChatImagePayload([msg("user", "x")], "   ").title).toBeUndefined();
    expect(buildChatImagePayload([msg("user", "x")]).title).toBeUndefined();
  });
});

describe("ShareToImageDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  });

  it("generates on open and shows the preview image once the PNG arrives", async () => {
    (api.chat.shareImage as Mock).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    render(<ShareToImageDialog messages={[msg("user", "你好")]} onClose={vi.fn()} />);

    // Header + selected count render immediately.
    expect(screen.getByText("生成图片")).toBeInTheDocument();
    expect(screen.getByText("已选 1 条")).toBeInTheDocument();

    // After the (mocked) request resolves, the preview <img> appears.
    await waitFor(() => expect(screen.getByAltText("对话图片预览")).toBeInTheDocument());
    // Opens with the default title, so it rides along in the payload.
    expect(api.chat.shareImage).toHaveBeenCalledWith({ title: "AI 对话摘录", messages: [{ role: "user", content: "你好", images: [] }] });
    expect(screen.getByAltText("对话图片预览")).toHaveAttribute("src", "blob:mock");
  });

  it("surfaces an error when generation fails", async () => {
    (api.chat.shareImage as Mock).mockRejectedValue(new Error("boom"));
    render(<ShareToImageDialog messages={[msg("user", "x")]} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });
});
