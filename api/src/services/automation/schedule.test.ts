import { describe, it, expect } from "vitest";
import { computeNextRun, normalizeSchedule, describeSchedule, retryDelayMs, MAX_AUTOMATION_RETRIES } from "./schedule.js";

// 北京时间 = UTC+8。构造一个「北京墙钟」对应的真实 UTC Date。
function beijing(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600_000);
}

describe("automation schedule", () => {
  it("cron 每天 07:00:今天已过 → 明天 07:00(北京)", () => {
    const now = beijing(2026, 7, 1, 9, 0); // 北京 7/1 09:00(周三)
    const next = computeNextRun("cron", { weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 0 }, now);
    expect(next!.getTime()).toBe(beijing(2026, 7, 2, 7, 0).getTime());
  });

  it("cron 每天 07:00:今天还没到 → 今天 07:00", () => {
    const now = beijing(2026, 7, 1, 6, 30);
    const next = computeNextRun("cron", { weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 0 }, now);
    expect(next!.getTime()).toBe(beijing(2026, 7, 1, 7, 0).getTime());
  });

  it("cron 工作日 09:00:周五 10:00 → 下周一 09:00", () => {
    const now = beijing(2026, 7, 3, 10, 0); // 2026-07-03 是周五
    const next = computeNextRun("cron", { weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, now);
    expect(next!.getTime()).toBe(beijing(2026, 7, 6, 9, 0).getTime()); // 07-06 周一
  });

  it("interval:now + everyMs", () => {
    const now = new Date(1_000_000_000_000);
    const next = computeNextRun("interval", { everyMs: 1_800_000 }, now);
    expect(next!.getTime()).toBe(1_000_000_000_000 + 1_800_000);
  });

  it("once:未来 → 该时刻;已过 → null", () => {
    const now = new Date(1_000_000_000_000);
    expect(computeNextRun("once", { atMs: 1_000_000_100_000 }, now)!.getTime()).toBe(1_000_000_100_000);
    expect(computeNextRun("once", { atMs: 999_999_000_000 }, now)).toBeNull();
  });

  it("生效区间:超过 to → null;早于 from → 从 from 起算", () => {
    const now = beijing(2026, 7, 1, 6, 0);
    const cfg = { weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 0 };
    // to = 今天 06:30(在 07:00 之前)→ 无有效下次
    expect(computeNextRun("cron", cfg, now, { to: beijing(2026, 7, 1, 6, 30).getTime() })).toBeNull();
    // from = 3 天后 → 下一次应 ≥ from
    const from = beijing(2026, 7, 4, 0, 0).getTime();
    const next = computeNextRun("cron", cfg, now, { from });
    expect(next!.getTime()).toBe(beijing(2026, 7, 4, 7, 0).getTime());
  });

  it("normalizeSchedule 校验非法配置", () => {
    expect(() => normalizeSchedule("cron", { weekdays: [], hour: 7, minute: 0 })).toThrow();
    expect(() => normalizeSchedule("cron", { weekdays: [1], hour: 24, minute: 0 })).toThrow();
    expect(() => normalizeSchedule("interval", { everyMs: 1000 })).toThrow(); // < 10 分钟
    expect(() => normalizeSchedule("interval", { everyMs: 5 * 60_000 })).toThrow();
    expect(normalizeSchedule("interval", { everyMs: 10 * 60_000 })).toEqual({ everyMs: 600_000 });
    expect(normalizeSchedule("cron", { weekdays: [3, 1, 1], hour: 9, minute: 5 })).toEqual({ weekdays: [1, 3], hour: 9, minute: 5 });
  });

  it("retryDelayMs 指数退避 + 上限;最多 5 次", () => {
    expect(retryDelayMs(0)).toBe(60_000);      // 1 分钟
    expect(retryDelayMs(1)).toBe(120_000);     // 2 分钟
    expect(retryDelayMs(2)).toBe(240_000);     // 4 分钟
    expect(retryDelayMs(3)).toBe(480_000);     // 8 分钟
    expect(retryDelayMs(4)).toBe(960_000);     // 16 分钟
    expect(retryDelayMs(10)).toBe(20 * 60_000); // 封顶 20 分钟
    expect(MAX_AUTOMATION_RETRIES).toBe(5);
  });

  it("describeSchedule 文案", () => {
    expect(describeSchedule("cron", { weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 0 })).toBe("每天 07:00");
    expect(describeSchedule("cron", { weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe("工作日 09:00");
    expect(describeSchedule("cron", { weekdays: [1, 3], hour: 9, minute: 0 })).toBe("每周一、周三 09:00");
    expect(describeSchedule("interval", { everyMs: 1_800_000 })).toBe("每 30 分钟");
    expect(describeSchedule("interval", { everyMs: 7_200_000 })).toBe("每 2 小时");
  });

  it("once:atMs 超出 Date 合法范围 → 抛错(API 层转 400)", () => {
    expect(() => normalizeSchedule("once", { atMs: 1e20 })).toThrow();
    expect(normalizeSchedule("once", { atMs: 1_800_000_000_000 })).toEqual({ atMs: 1_800_000_000_000 });
  });
});
