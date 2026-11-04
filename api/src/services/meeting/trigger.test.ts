import { describe, it, expect } from "vitest";
import type { MeetingConfig } from "@team-knowledge/shared";
import { TriggerEngine } from "./trigger.js";
import { buildWakeWordRegex } from "../../utils/assistant.js";

function defaultConfig(overrides: Partial<MeetingConfig> = {}): MeetingConfig {
  return {
    tts: true,
    recording: true,
    // freqLimitMessages=1 + freqLimitMinutes=5 is the original
    // "one comment per 5 minutes" behavior; keeping it as the test
    // default lets the pre-existing throttle assertions stay valid.
    freqLimitMinutes: 5,
    freqLimitMessages: 1,
    triggerSilence: true,
    triggerKeyword: true,
    triggerProactive: true,
    durationHintHours: 4,
    style: "neutral",
    ...overrides,
  };
}

describe("TriggerEngine", () => {
  it("fires explicit_wake on default wake word '小助手' regardless of throttle", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    const d = eng.onTranscriptFinal({ text: "嘿 小助手 你来一下", endMs: 1000 });
    expect(d.fire).toBe(true);
    if (d.fire) expect(d.trigger).toBe("explicit_wake");
  });

  it("fires explicit_wake on '@小助手' too", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    const d = eng.onTranscriptFinal({ text: "@小助手,帮我查一下", endMs: 1000 });
    expect(d.fire).toBe(true);
  });

  it("buildWakeWordRegex supports multiple words, case-insensitive, escapes regex chars, falls back when empty", () => {
    const re = buildWakeWordRegex("小智, Bot, a.b");
    expect(re.test("你好 小智")).toBe(true);
    expect(re.test("hey BOT")).toBe(true);
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
    expect(re.test("小助手")).toBe(false);
    expect(buildWakeWordRegex(" , ").test("小助手")).toBe(true);
  });

  it("fires keyword trigger on '我们以前/上次/那个文档' style references", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    const d = eng.onTranscriptFinal({ text: "我们以前那个支付方案是怎么定的", endMs: 1000 });
    expect(d.fire).toBe(true);
    if (d.fire) expect(d.trigger).toBe("keyword");
  });

  it("does NOT fire keyword trigger when triggerKeyword=false", () => {
    const eng = new TriggerEngine(defaultConfig({ triggerKeyword: false }), 0);
    const d = eng.onTranscriptFinal({ text: "我们以前那个方案", endMs: 1000 });
    expect(d.fire).toBe(false);
  });

  it("throttles natural triggers within freqLimit", () => {
    const eng = new TriggerEngine(defaultConfig({ freqLimitMinutes: 5 }), 0);
    eng.recordComment(0);
    const d = eng.onTranscriptFinal({ text: "我们以前那个文档", endMs: 60_000 }); // 1 min later
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toMatch(/throttled/);
  });

  it("explicit_wake bypasses throttle", () => {
    const eng = new TriggerEngine(defaultConfig({ freqLimitMinutes: 5 }), 0);
    eng.recordComment(0);
    const d = eng.onTranscriptFinal({ text: "小助手 紧急情况", endMs: 60_000 });
    expect(d.fire).toBe(true);
    if (d.fire) expect(d.trigger).toBe("explicit_wake");
  });

  it("silence trigger: requires 12s+ gap AND open question", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    eng.onTranscriptFinal({ text: "这个方案靠谱吗?", endMs: 1000 });
    // Less than 12s gap — no fire.
    let d = eng.evaluateSilence(8_000);
    expect(d.fire).toBe(false);
    // 14s later, open question on the floor — fires.
    d = eng.evaluateSilence(15_000);
    expect(d.fire).toBe(true);
    if (d.fire) expect(d.trigger).toBe("silence");
  });

  it("proactive trigger fires once enough new finals accrue", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    for (let i = 1; i <= 6; i++) eng.onTranscriptFinal({ text: `第${i}句`, endMs: i * 1000 });
    const d = eng.evaluateProactive(7_000);
    expect(d.fire).toBe(true);
    if (d.fire) expect(d.trigger).toBe("proactive");
  });

  it("proactive trigger respects triggerProactive=false", () => {
    const eng = new TriggerEngine(defaultConfig({ triggerProactive: false }), 0);
    for (let i = 1; i <= 8; i++) eng.onTranscriptFinal({ text: `第${i}句`, endMs: i * 1000 });
    expect(eng.evaluateProactive(9_000).fire).toBe(false);
  });

  it("proactive cadence does NOT advance on a decision that bails (no recordComment)", () => {
    // Regression: evaluateProactive used to stamp lastProactiveAtMs the
    // instant it returned fire:true — even though the chime could still bail
    // downstream (assistantBusy / shutdown / saturated cap) and never call
    // recordComment. That left the proactive trigger blocked for the full
    // cadence despite assistant saying nothing. Now the stamp lives in
    // recordComment, so a fire-but-bail (we just never call recordComment)
    // lets the very next eval fire again.
    const eng = new TriggerEngine(defaultConfig(), 0);
    for (let i = 1; i <= 6; i++) eng.onTranscriptFinal({ text: `第${i}句`, endMs: i * 1000 });
    expect(eng.evaluateProactive(7_000).fire).toBe(true);
    // Simulate the chime bailing: recordComment never runs. A second eval at
    // the SAME accrual must still fire (cadence wasn't optimistically stamped).
    expect(eng.evaluateProactive(7_500).fire).toBe(true);
  });

  it("proactive cadence DOES hold after a real comment (recordComment stamps it)", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    for (let i = 1; i <= 6; i++) eng.onTranscriptFinal({ text: `第${i}句`, endMs: i * 1000 });
    expect(eng.evaluateProactive(7_000).fire).toBe(true);
    eng.recordComment(7_000); // a comment actually went out → cadence stamped
    // Accrue MORE than enough new discussion, but stay inside the cadence gate.
    for (let i = 7; i <= 14; i++) eng.onTranscriptFinal({ text: `第${i}句`, endMs: i * 1000 });
    const d = eng.evaluateProactive(20_000); // 13s since the comment < 60s cadence
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toMatch(/cadence/);
  });

  it("proactive accrual resets after a comment", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    for (let i = 1; i <= 6; i++) eng.onTranscriptFinal({ text: `第${i}句`, endMs: i * 1000 });
    expect(eng.evaluateProactive(7_000).fire).toBe(true);
    eng.recordComment(7_000); // resets the proactive accrual counters
    eng.onTranscriptFinal({ text: "甲", endMs: 8_000 });
    eng.onTranscriptFinal({ text: "乙", endMs: 9_000 });
    // Past the proactive cadence gate, but only 2 new finals / 2s of fresh
    // discussion since the last comment → not enough → no fire.
    expect(eng.evaluateProactive(70_000).fire).toBe(false);
  });

  it("silence trigger does NOT fire when last sentence isn't a question", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    eng.onTranscriptFinal({ text: "好的就这样定了", endMs: 1000 });
    const d = eng.evaluateSilence(60_000);
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toMatch(/open question/);
  });

  it("silence trigger respects triggerSilence=false", () => {
    const eng = new TriggerEngine(defaultConfig({ triggerSilence: false }), 0);
    eng.onTranscriptFinal({ text: "这样可以吗?", endMs: 1000 });
    const d = eng.evaluateSilence(60_000);
    expect(d.fire).toBe(false);
  });

  it("manual evaluators always fire (until the comment cap)", () => {
    const eng = new TriggerEngine(defaultConfig({ freqLimitMinutes: 60 }), 0);
    eng.recordComment(0);
    expect(eng.evaluateManual("manual_button", 0).fire).toBe(true);
    expect(eng.evaluateManual("user_question", 0).fire).toBe(true);
  });

  it("comment cap scales with meeting length: blocks at the floor early, but grows over time", () => {
    const eng = new TriggerEngine(defaultConfig(), 0);
    // At elapsed≈0 the budget is the floor (COMMENT_CAP_BASE = 30). Fill it.
    for (let i = 0; i < 30; i++) eng.recordComment(0);
    // Still at the start → at/over the floor → blocked, even for a manual ask.
    const blocked = eng.evaluateManual("user_question", 0);
    expect(blocked.fire).toBe(false);
    if (!blocked.fire) expect(blocked.reason).toMatch(/comment cap/);
    // 30 minutes into the meeting the budget has grown well past 30 (30 + 30*3
    // = 120) → the SAME comment count is now under budget → fires again. This
    // is the fix for "assistant went silent at 20": the cap tracks the meeting.
    const later = eng.evaluateManual("user_question", 30 * 60_000);
    expect(later.fire).toBe(true);
  });
});
