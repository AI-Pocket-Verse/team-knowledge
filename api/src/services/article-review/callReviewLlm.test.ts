import { describe, it, expect, vi } from "vitest";
import type { ChatChunk, ChatPrompt } from "../llm/types.js";

// callReviewLlm 逐 token 消费 provider.chat 并累加成整篇;本测试验证新增的 onToken 回调
// 会按序收到每个 token,且返回值仍是整篇拼接(累加逻辑不变)。stub 掉真实 provider,只出 3 个 token。
const TOKENS = ["改", "好", "了"];

vi.mock("../llm/registry.js", () => ({
  getProvider: async () => ({
    name: "claude" as const,
    isAvailable: async () => ({ ok: true }),
    async *chat(_prompt: ChatPrompt | Promise<ChatPrompt>): AsyncGenerator<ChatChunk> {
      await _prompt;
      for (const t of TOKENS) yield { type: "token", text: t };
      yield { type: "done" };
    },
  }),
}));

describe("callReviewLlm onToken", () => {
  it("逐 token 回调 onToken,且返回整篇拼接", async () => {
    const { callReviewLlm } = await import("./review.js");
    const seen: string[] = [];
    const text = await callReviewLlm("sys", "user", undefined, (t) => seen.push(t));
    expect(seen).toEqual(TOKENS);
    expect(text).toBe(TOKENS.join(""));
  });

  it("不传 onToken 时行为不变(仍返回整篇)", async () => {
    const { callReviewLlm } = await import("./review.js");
    const text = await callReviewLlm("sys", "user");
    expect(text).toBe(TOKENS.join(""));
  });
});
