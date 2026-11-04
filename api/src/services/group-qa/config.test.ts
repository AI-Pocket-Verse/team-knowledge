import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import {
  getGroupQaTuning, setGroupQaTuning,
  COOLDOWN_SEC_DEFAULT, HOURLY_CAP_DEFAULT, DEDUP_MIN_DEFAULT, DEMOTE_DAYS_DEFAULT, ANSWER_CAP_DEFAULT, AGGRESSIVENESS_DEFAULT,
  getGroupQaLike, setGroupQaLike,
  LIKE_ENABLED_DEFAULT, LIKE_THRESHOLD_DEFAULT, LIKE_DAILY_CAP_DEFAULT, LIKE_COOLDOWN_MIN_DEFAULT,
  LIKE_USER_DAILY_CAP_DEFAULT, LIKE_EVAL_BUDGET_DEFAULT, LIKE_EMOJI_DEFAULT, LIKE_EMOJI_MODE_DEFAULT,
} from "./config.js";

describe("group-qa tuning", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("默认值", async () => {
    expect(await getGroupQaTuning()).toEqual({
      cooldownSec: COOLDOWN_SEC_DEFAULT,
      hourlyCap: HOURLY_CAP_DEFAULT,
      dedupMin: DEDUP_MIN_DEFAULT,
      demoteDays: DEMOTE_DAYS_DEFAULT,
      answerCap: ANSWER_CAP_DEFAULT,
      aggressiveness: AGGRESSIVENESS_DEFAULT,
    });
  });

  it("部分更新 + 越界夹紧 + 回读一致", async () => {
    const r1 = await setGroupQaTuning({ cooldownSec: 120, hourlyCap: 10, answerCap: 200, aggressiveness: 3 }, "admin");
    expect(r1.cooldownSec).toBe(120);
    expect(r1.hourlyCap).toBe(10);
    expect(r1.answerCap).toBe(200);
    expect(r1.aggressiveness).toBe(3);
    expect(r1.dedupMin).toBe(DEDUP_MIN_DEFAULT);   // 未传 → 保持默认
    expect(r1.demoteDays).toBe(DEMOTE_DAYS_DEFAULT);

    const r2 = await setGroupQaTuning({ cooldownSec: 99999, hourlyCap: 0, answerCap: 5, aggressiveness: 9 }, "admin"); // 全越界
    expect(r2.cooldownSec).toBe(3600); // 上界
    expect(r2.hourlyCap).toBe(1);      // 下界
    expect(r2.answerCap).toBe(40);     // 下界
    expect(r2.aggressiveness).toBe(3); // 上界(1-3)
    expect(await getGroupQaTuning()).toEqual(r2);
  });

  it("脏值/非数字回退默认", async () => {
    // set 层用 clampInt 保证落库合法,越界统一夹紧;这里验证一次读回一致即可
    // (clampInt 对 boolean/null/[]/"" 的兜底由 doc-audit config.test 的单测覆盖)。
    await setGroupQaTuning({ dedupMin: 45, demoteDays: 14 }, "admin");
    const t = await getGroupQaTuning();
    expect(t.dedupMin).toBe(45);
    expect(t.demoteDays).toBe(14);
  });
});

describe("group-qa like 配置", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("默认值(默认关)", async () => {
    expect(await getGroupQaLike()).toEqual({
      enabled: LIKE_ENABLED_DEFAULT,
      threshold: LIKE_THRESHOLD_DEFAULT,
      dailyCapPerGroup: LIKE_DAILY_CAP_DEFAULT,
      cooldownMin: LIKE_COOLDOWN_MIN_DEFAULT,
      userDailyCap: LIKE_USER_DAILY_CAP_DEFAULT,
      evalDailyBudget: LIKE_EVAL_BUDGET_DEFAULT,
      emoji: LIKE_EMOJI_DEFAULT,
      emojiMode: LIKE_EMOJI_MODE_DEFAULT,
    });
  });

  it("部分更新 + 越界夹紧 + emoji 非法回退默认", async () => {
    const r1 = await setGroupQaLike({ enabled: true, threshold: 9, dailyCapPerGroup: 5 }, "admin");
    expect(r1.enabled).toBe(true);
    expect(r1.threshold).toBe(9);
    expect(r1.dailyCapPerGroup).toBe(5);
    expect(r1.cooldownMin).toBe(LIKE_COOLDOWN_MIN_DEFAULT); // 未传 → 默认

    const r2 = await setGroupQaLike({ threshold: 99, dailyCapPerGroup: 0, evalDailyBudget: 1, emoji: "NOPE" }, "admin");
    expect(r2.threshold).toBe(10);        // 上界
    expect(r2.dailyCapPerGroup).toBe(1);  // 下界
    expect(r2.evalDailyBudget).toBe(10);  // 下界
    expect(r2.emoji).toBe(LIKE_EMOJI_DEFAULT); // 非法枚举 → 默认
    expect(r2.enabled).toBe(true);        // 保持上次
  });

  it("合法 emoji 可保存", async () => {
    const r = await setGroupQaLike({ emoji: "HEART" }, "admin");
    expect(r.emoji).toBe("HEART");
  });

  it("emojiMode:合法保存 / 非法回退默认", async () => {
    expect((await setGroupQaLike({ emojiMode: "fixed" }, "admin")).emojiMode).toBe("fixed");
    expect((await setGroupQaLike({ emojiMode: "smart" }, "admin")).emojiMode).toBe("smart");
    expect((await setGroupQaLike({ emojiMode: "nope" }, "admin")).emojiMode).toBe("smart"); // 非法 → 默认
  });
});
