import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { UiChatMessage } from "@/stores/chat";
import { ChatMessageList } from "./ChatMessageList";

const u: UiChatMessage = { id: "u1", role: "user", content: "问", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:00Z" };

function view(messages: UiChatMessage[], status: "idle" | "streaming" = "idle") {
  return render(
    <MemoryRouter>
      <ChatMessageList messages={messages} status={status} error={null} roleName={(id) => (id === "r1" ? "产品" : id)} onEscalationHandled={() => {}} />
    </MemoryRouter>,
  );
}

describe("ChatMessageList · 专家附加件", () => {
  it("专家终稿:渲染出处芯片", () => {
    const a: UiChatMessage = { id: "a1", role: "assistant", content: "答完", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:01:00Z", trace: [{ type: "answered", roleId: "r1" }], citations: [{ source: "doc", title: "登录方案", ref: "x1" }] };
    view([u, a]);
    expect(screen.getByText(/登录方案/)).toBeTruthy();
  });

  it("专家流式空占位:显示实时状态而非被裁掉", () => {
    const a: UiChatMessage = { id: "a2", role: "assistant", content: "", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:01:00Z", trace: [], targets: ["r1"] };
    view([u, a], "streaming");
    expect(screen.getByText(/产品|应答|思考/)).toBeTruthy();
  });

  it("气泡旧链路 assistant(trace undefined)不渲染附加件", () => {
    const a: UiChatMessage = { id: "a3", role: "assistant", content: "普通答复", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:01:00Z" };
    view([u, a]);
    expect(screen.getByText("普通答复")).toBeTruthy();
  });

  it("多选态(受控 selecting):浮出操作条,无旧顶部整行", () => {
    const a: UiChatMessage = { id: "a4", role: "assistant", content: "答完", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:01:00Z" };
    render(
      <MemoryRouter>
        <ChatMessageList messages={[u, a]} status="idle" error={null} selecting onSelectingChange={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("分享到文档")).toBeTruthy();
    expect(screen.getByText("生成图片")).toBeTruthy();
    expect(screen.getByText(/已选/)).toBeTruthy();
  });

  it("非多选态:不渲染操作条", () => {
    view([u]);
    expect(screen.queryByText("分享到文档")).toBeNull();
  });

  it("loadingOlder=true → 顶部显示「加载更早…」", () => {
    render(
      <MemoryRouter>
        <ChatMessageList messages={[u]} status="idle" error={null} hasMoreOlder loadingOlder onLoadOlder={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/加载更早/)).toBeTruthy();
  });
});
