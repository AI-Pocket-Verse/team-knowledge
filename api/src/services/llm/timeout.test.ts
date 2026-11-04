import { describe, it, expect, afterEach } from "vitest";
import { startIdleHardTimer } from "./timeout.js";

const KEYS = ["LLM_IDLE_TIMEOUT_MS", "LLM_TIMEOUT_MS", "LLM_HARD_TIMEOUT_MS"] as const;

describe("startIdleHardTimer 环境变量", () => {
  afterEach(() => { for (const k of KEYS) delete process.env[k]; });

  it("合法数值生效", () => {
    process.env.LLM_IDLE_TIMEOUT_MS = "45000";
    process.env.LLM_HARD_TIMEOUT_MS = "300000";
    const t = startIdleHardTimer(() => {});
    t.disarm();
    expect([t.idleMs, t.hardMs]).toEqual([45_000, 300_000]);
  });

  it("非数字 / 非正数回落默认值,而不是 NaN 立即超时", () => {
    process.env.LLM_IDLE_TIMEOUT_MS = "abc";
    process.env.LLM_HARD_TIMEOUT_MS = "-5";
    const t = startIdleHardTimer(() => {});
    t.disarm();
    expect([t.idleMs, t.hardMs]).toEqual([90_000, 600_000]);
  });

  it("LLM_IDLE_TIMEOUT_MS 无效时仍可用旧别名 LLM_TIMEOUT_MS", () => {
    process.env.LLM_IDLE_TIMEOUT_MS = "abc";
    process.env.LLM_TIMEOUT_MS = "120000";
    const t = startIdleHardTimer(() => {});
    t.disarm();
    expect(t.idleMs).toBe(120_000);
  });
});
