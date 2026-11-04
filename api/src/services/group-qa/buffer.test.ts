import { describe, it, expect, beforeEach } from "vitest";
import { appendMessage, recentMessages, _resetBuffers, type GroupMsg } from "./buffer.js";

const msg = (i: number): GroupMsg => ({ messageId: `om_${i}`, openId: `ou_${i}`, senderName: `U${i}`, text: `t${i}`, ts: i });

beforeEach(() => _resetBuffers());

describe("group-qa buffer", () => {
  it("按群隔离,保序追加", () => {
    appendMessage("c1", msg(1));
    appendMessage("c1", msg(2));
    appendMessage("c2", msg(9));
    expect(recentMessages("c1").map((m) => m.text)).toEqual(["t1", "t2"]);
    expect(recentMessages("c2").map((m) => m.text)).toEqual(["t9"]);
    expect(recentMessages("c3")).toEqual([]);
  });

  it("超过容量(8)丢最旧、留最近", () => {
    for (let i = 1; i <= 11; i++) appendMessage("c1", msg(i));
    const texts = recentMessages("c1").map((m) => m.text);
    expect(texts).toHaveLength(8);
    expect(texts[0]).toBe("t4"); // 1..3 被挤掉
    expect(texts[7]).toBe("t11");
  });
});
