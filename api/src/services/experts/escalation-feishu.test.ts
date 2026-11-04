import { describe, it, expect } from "vitest";
import { buildEscalationCard } from "./escalation.js";

describe("experts/escalation 飞书卡片", () => {
  it("buildEscalationCard:候选变按钮,value 带 escalationId+option", () => {
    const card = buildEscalationCard("esc1", {
      roleName: "技术", background: "续期时长无法定", question: "JWT 滑动续期选 7 天还是 30 天?", options: ["7 天", "30 天"],
    }) as any;
    const action = card.elements.find((e: any) => e.tag === "action");
    expect(action.actions).toHaveLength(2);
    expect(action.actions[0].value).toEqual({ kind: "expert_escalation", escalationId: "esc1", option: "7 天" });
  });
});
