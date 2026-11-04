import { describe, it, expect } from "vitest";
import { streamingStatus } from "./streamingStatus";
import type { ExpertTraceEvent } from "@/lib/api";

const rn = (id: string) => ({ "r-prod": "产品", "r-tech": "技术" }[id] ?? id);

describe("streamingStatus", () => {
  it("无 trace(尚无分诊结果)→ AI 思考中(先经门控)", () => {
    expect(streamingStatus(undefined, rn)).toBe("AI 思考中…");
  });

  it("选了专家但还没分诊结果 → 仍先显示 AI 思考中(不抢显专家)", () => {
    // 选了专家也要先经助手门控:通用问题助手自答,真需专家才翻成「xx 专家应答中…」。
    expect(streamingStatus([], rn)).toBe("AI 思考中…");
  });

  it("已分诊到多专家 → 列出专家应答中", () => {
    const lt: ExpertTraceEvent[] = [{ type: "routed", roleIds: ["r-prod", "r-tech"] }];
    expect(streamingStatus(lt, rn)).toBe("产品、技术专家应答中…");
  });

  it("分诊未匹配到专家(空)→ AI 思考中", () => {
    expect(streamingStatus([{ type: "routed", roleIds: [] }], rn)).toBe("AI 思考中…");
  });

  it("阶段优先级:汇总 > 应答;升级/请教各有文案", () => {
    const summarizing: ExpertTraceEvent[] = [
      { type: "routed", roleIds: ["r-prod", "r-tech"] },
      { type: "answered", roleId: "r-prod" },
      { type: "summarized" },
    ];
    expect(streamingStatus(summarizing, rn)).toBe("正在汇总各专家意见…");
    expect(streamingStatus([{ type: "routed", roleIds: ["r-prod"] }, { type: "consult", roleId: "r-tech" }], rn)).toBe("正在跨专家请教…");
    expect(streamingStatus([{ type: "escalation", roleId: "r-prod" }], rn)).toBe("正在升级给负责人…");
  });
});
