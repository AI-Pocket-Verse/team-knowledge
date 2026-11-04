import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MeetingCommentRow } from "@team-knowledge/shared";
import { AssistantPanel } from "./AssistantPanel";

function comment(overrides: Partial<MeetingCommentRow> = {}): MeetingCommentRow {
  return {
    id: "c1",
    triggerType: "proactive",
    triggeredByUserId: null,
    triggeredByName: null,
    text: "大家好，我是 AI。",
    citedArticleIds: [],
    citedRefs: [],
    ttsAudioUrl: null,
    atMs: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("AssistantPanel", () => {
  it("live mode renders the composer + 发送 button", () => {
    render(
      <AssistantPanel
        comments={[comment()]}
        startedAtMs={0}
        lastSkipped={null}
        onAsk={vi.fn()}
        isHost={false}
      />,
    );
    expect(screen.getByPlaceholderText("向 AI 提问…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("live mode: typing + 发送 fires onAsk and shows the thinking spinner", () => {
    const onAsk = vi.fn();
    render(
      <AssistantPanel
        comments={[comment()]}
        startedAtMs={0}
        lastSkipped={null}
        onAsk={onAsk}
        isHost={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("向 AI 提问…"), {
      target: { value: "这次会议的结论是什么？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onAsk).toHaveBeenCalledWith("这次会议的结论是什么？");
    expect(screen.getByText("你的提问")).toBeInTheDocument();
    expect(screen.getByText("AI 正在思考")).toBeInTheDocument();
  });

  it("read-only mode hides the composer (no input, no 发送 button)", () => {
    render(
      <AssistantPanel
        comments={[comment()]}
        startedAtMs={0}
        lastSkipped={null}
        onAsk={vi.fn()}
        isHost={false}
        readOnly
      />,
    );
    // The timeline still renders the comment…
    expect(screen.getByText("大家好，我是 AI。")).toBeInTheDocument();
    // …but there is no way to type or send a phantom question.
    expect(screen.queryByPlaceholderText("向 AI 提问…")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("renders cited docs as clickable 《title》 links (new tab) after the comment", () => {
    render(
      <MemoryRouter>
        <AssistantPanel
          comments={[comment({
            citedArticleIds: ["a1", "a2"],
            citedRefs: [
              { articleId: "a1", title: "支付方案" },
              { articleId: "a2", title: "上次会议纪要" },
            ],
          })]}
          startedAtMs={0}
          lastSkipped={null}
          onAsk={vi.fn()}
          isHost={false}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "《支付方案》" });
    expect(link).toHaveAttribute("href", "/d/a1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "《上次会议纪要》" })).toHaveAttribute("href", "/d/a2");
    // The bare "引用了 N 篇文档" count is replaced by the links, not shown alongside.
    expect(screen.queryByText(/引用了 .* 篇文档/)).toBeNull();
  });

  it("hints at deleted cited docs when only some titles resolve", () => {
    render(
      <MemoryRouter>
        <AssistantPanel
          comments={[comment({
            citedArticleIds: ["a1", "a2", "a3"],
            citedRefs: [{ articleId: "a1", title: "保留文档" }],
          })]}
          startedAtMs={0}
          lastSkipped={null}
          onAsk={vi.fn()}
          isHost={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "《保留文档》" })).toBeInTheDocument();
    expect(screen.getByText("+2 篇已删除")).toBeInTheDocument();
  });

  it("falls back to the count when ids are cited but titles didn't resolve", () => {
    render(
      <MemoryRouter>
        <AssistantPanel
          comments={[comment({ citedArticleIds: ["a1", "a2"], citedRefs: [] })]}
          startedAtMs={0}
          lastSkipped={null}
          onAsk={vi.fn()}
          isHost={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("📎 引用了 2 篇文档")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
