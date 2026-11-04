import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import {
  getReviewEnabled, setReviewEnabled, getReviewSettings, setReviewSettings,
  getScanIntervalSec, getIdleMinutes, clampInt,
  SCAN_INTERVAL_DEFAULT_SEC, IDLE_DEFAULT_MIN,
} from "./config.js";

describe("article-review 总开关", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("默认关闭;可开可关", async () => {
    expect(await getReviewEnabled()).toBe(false);
    await setReviewEnabled(true, "admin");
    expect(await getReviewEnabled()).toBe(true);
    await setReviewEnabled(false, "admin");
    expect(await getReviewEnabled()).toBe(false);
  });
});

describe("article-review 运行参数(间隔/阈值)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("clampInt 取整夹紧 + 非法回退", () => {
    expect(clampInt(50, 30, 3600, 120)).toBe(50);
    expect(clampInt(10, 30, 3600, 120)).toBe(30);   // 低于下界
    expect(clampInt(99999, 30, 3600, 120)).toBe(3600); // 高于上界
    expect(clampInt("abc", 30, 3600, 120)).toBe(120); // 非法 → 默认
    expect(clampInt("60", 30, 3600, 120)).toBe(60);  // 数字字符串
    expect(clampInt(50.9, 30, 3600, 120)).toBe(50);  // 取整
    // 强转陷阱:这些必须回退默认,而不是被 Number() 变成 0/1 再夹成 min。
    expect(clampInt("", 30, 3600, 120)).toBe(120);
    expect(clampInt(null, 30, 3600, 120)).toBe(120);
    expect(clampInt(true, 30, 3600, 120)).toBe(120);
    expect(clampInt([5], 30, 3600, 120)).toBe(120);
  });

  it("默认值", async () => {
    expect(await getScanIntervalSec()).toBe(SCAN_INTERVAL_DEFAULT_SEC);
    expect(await getIdleMinutes()).toBe(IDLE_DEFAULT_MIN);
    const reminderDefaults = { reminderEnabled: false, reminderHour: 10, reminderMinute: 0, reminderWeekdays: [1, 2, 3, 4, 5] };
    expect(await getReviewSettings()).toEqual({ enabled: false, scanIntervalSec: SCAN_INTERVAL_DEFAULT_SEC, idleMinutes: IDLE_DEFAULT_MIN, minSeverity: "med", ...reminderDefaults });
  });

  it("setReviewSettings 部分更新 + 越界夹紧 + 回读一致", async () => {
    const reminderDefaults = { reminderEnabled: false, reminderHour: 10, reminderMinute: 0, reminderWeekdays: [1, 2, 3, 4, 5] };
    const r1 = await setReviewSettings({ enabled: true, scanIntervalSec: 300, idleMinutes: 5 }, "admin");
    expect(r1).toEqual({ enabled: true, scanIntervalSec: 300, idleMinutes: 5, minSeverity: "med", ...reminderDefaults });
    const r2 = await setReviewSettings({ scanIntervalSec: 5, idleMinutes: 99999 }, "admin"); // 越界
    expect(r2.scanIntervalSec).toBe(30);     // 夹到下界
    expect(r2.idleMinutes).toBe(1440);       // 夹到上界
    expect(r2.enabled).toBe(true);           // 未传 → 保持
    expect(await getReviewSettings()).toEqual(r2);
  });

  it("提醒配置:星期归一化 + 时/分夹紧", async () => {
    const r = await setReviewSettings({ reminderEnabled: true, reminderHour: 30, reminderMinute: -5, reminderWeekdays: [3, 1, 1, 9, 5] }, "admin");
    expect(r.reminderEnabled).toBe(true);
    expect(r.reminderHour).toBe(23);          // 越界夹到上界
    expect(r.reminderMinute).toBe(0);         // 负数夹到下界
    expect(r.reminderWeekdays).toEqual([1, 3, 5]); // 去重 + 去非法(9) + 升序
  });
});
