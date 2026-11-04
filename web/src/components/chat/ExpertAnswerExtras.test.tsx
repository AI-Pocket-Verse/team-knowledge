import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { UiChatMessage } from "@/stores/chat";

vi.mock("@/components/experts/EscalationDecisionCard", () => ({ EscalationDecisionCard: () => <div>esc-card</div> }));

import { ExpertAnswerExtras } from "./ExpertAnswerExtras";

const base: UiChatMessage = { id: "m1", role: "assistant", content: "", citedArticleIds: [], citedRefs: [], mentions: [], createdAt: "2026-06-25T00:00:00Z" };
const wrap = (m: UiChatMessage, streaming: boolean) =>
  render(<MemoryRouter><ExpertAnswerExtras m={m} roleName={(id) => (id === "r1" ? "产品" : id)} streaming={streaming} onEscalationHandled={() => {}} /></MemoryRouter>);

describe("ExpertAnswerExtras", () => {
  it("气泡旧链路(trace undefined)→ 不渲染", () => {
    const { container } = wrap(base, false);
    expect(container.textContent).toBe("");
  });

  it("流式且无正文 → 实时状态行", () => {
    wrap({ ...base, trace: [], targets: ["r1"] }, true);
    expect(screen.getByText(/产品|应答|思考/)).toBeTruthy();
  });

  it("生图阶段:已有思路前言(content 非空)但图未落地 → 仍显示「正在生成图片…」", () => {
    wrap({ ...base, content: "我帮你画一张简洁介绍图", trace: [{ type: "routed", roleIds: [] }, { type: "image" }] }, true);
    expect(screen.getByText(/正在生成图片/)).toBeTruthy();
  });

  it("生图完成(images 已落地)→ 不再显示生成中状态(走终稿)", () => {
    wrap({ ...base, content: "我帮你画一张简洁介绍图", trace: [{ type: "routed", roleIds: [] }, { type: "image" }], images: ["/uploads/x.png"] }, false);
    expect(screen.queryByText(/正在生成图片/)).toBeNull();
  });

  it("刷新重建:无 trace 但有 citations → 仍渲染出处芯片", () => {
    wrap({ ...base, content: "答", citations: [{ source: "doc", title: "登录方案", ref: "a1" }] }, false);
    expect(screen.getByText(/登录方案/)).toBeTruthy();
  });

  it("终稿 → trace + 出处芯片", () => {
    wrap({ ...base, content: "答", trace: [{ type: "routed", roleIds: ["r1"] }, { type: "answered", roleId: "r1" }], citations: [{ source: "doc", title: "登录方案", ref: "a1" }] }, false);
    expect(screen.getByText(/登录方案/)).toBeTruthy();
  });

  it("终稿带未处理升级 → 渲染决策卡", () => {
    wrap({ ...base, content: "答", trace: [], escalation: { id: "e1", roleId: "r1", background: "b", question: "q", options: [] } }, false);
    expect(screen.getByText("esc-card")).toBeTruthy();
  });

  it("升级已处理 → 不渲染决策卡", () => {
    wrap({ ...base, content: "答", trace: [], escalation: { id: "e1", roleId: "r1", background: "b", question: "q", options: [] }, escalationHandled: true }, false);
    expect(screen.queryByText("esc-card")).toBeNull();
  });
});
