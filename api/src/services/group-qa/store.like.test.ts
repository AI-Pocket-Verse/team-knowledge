import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { recordLike, alreadyLiked, likeCounters, tryConsumeEvalBudget, recentLikes, type LikeEntry } from "./store.js";

const NOW = Date.UTC(2026, 6, 9, 4, 0, 0); // 北京 2026-07-09 12:00
function entry(over: Partial<LikeEntry>): LikeEntry {
  return {
    messageId: "om_1", chatId: "oc_a", chatName: "群A", openId: "ou_u1",
    senderName: "张三", score: 8, emoji: "THUMBSUP", preview: "分享一个方案", at: NOW, ...over,
  };
}

describe("group-qa like store", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("recordLike + alreadyLiked 去重", async () => {
    expect(await alreadyLiked("om_1")).toBe(false);
    await recordLike(entry({ messageId: "om_1" }));
    expect(await alreadyLiked("om_1")).toBe(true);
    expect(await alreadyLiked("om_2")).toBe(false);
    expect((await recentLikes()).length).toBe(1);
  });

  it("likeCounters:今日群/人计数 + 群最近点赞时刻", async () => {
    await recordLike(entry({ messageId: "om_1", at: NOW }));
    await recordLike(entry({ messageId: "om_2", at: NOW + 1000, openId: "ou_u2" }));         // 同群不同人
    await recordLike(entry({ messageId: "om_3", at: NOW + 2000, chatId: "oc_b" }));           // 别的群、同人 u1
    const c = await likeCounters("oc_a", "ou_u1", NOW + 3000);
    expect(c.groupToday).toBe(2);          // oc_a 今日两条
    expect(c.userToday).toBe(2);           // ou_u1 今日两条(oc_a 的 om_1 + oc_b 的 om_3)
    expect(c.lastGroupAt).toBe(NOW + 1000); // oc_a 最近一条
  });

  it("likeCounters:昨天的点赞不计入今日", async () => {
    await recordLike(entry({ messageId: "om_old", at: NOW - 2 * 86_400_000 }));
    const c = await likeCounters("oc_a", "ou_u1", NOW);
    expect(c.groupToday).toBe(0);
    expect(c.lastGroupAt).toBe(NOW - 2 * 86_400_000); // 冷却看绝对时刻,仍记录
  });

  it("tryConsumeEvalBudget:今日累计到预算即拒绝", async () => {
    expect(await tryConsumeEvalBudget(NOW, 2)).toBe(true);  // 1
    expect(await tryConsumeEvalBudget(NOW, 2)).toBe(true);  // 2
    expect(await tryConsumeEvalBudget(NOW, 2)).toBe(false); // 超
    // 次日预算重置
    expect(await tryConsumeEvalBudget(NOW + 86_400_000, 2)).toBe(true);
  });
});
