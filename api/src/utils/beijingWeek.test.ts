import { describe, it, expect } from "vitest";
import {
  beijingDayKey,
  beijingWeekOf,
  previousBeijingWeek,
  beijingWeekDayKeys,
  msUntilNextBeijingMonday,
  beijingWeekLabel,
  beijingWorkWeekLabel,
  stripCnTz,
} from "./beijingWeek.js";

const DAY = 86400000;
// Beijing wall-clock weekday (1=Mon..7=Sun) of a UTC instant — used to assert
// invariants without hardcoding which calendar date is a Monday.
function beijingIsoDow(d: Date): number {
  const dow = new Date(d.getTime() + 8 * 3600000).getUTCDay();
  return dow === 0 ? 7 : dow;
}

describe("beijingWeekOf", () => {
  const d = new Date("2026-06-10T12:00:00Z"); // arbitrary mid-week instant
  const w = beijingWeekOf(d);

  it("starts on a Beijing Monday and spans exactly 7 days", () => {
    expect(beijingIsoDow(w.weekStart)).toBe(1);
    expect(w.weekEnd.getTime() - w.weekStart.getTime()).toBe(7 * DAY);
  });

  it("contains the instant in [weekStart, weekEnd)", () => {
    expect(w.weekStart.getTime()).toBeLessThanOrEqual(d.getTime());
    expect(d.getTime()).toBeLessThan(w.weekEnd.getTime());
  });

  it("weekKey is the Beijing date of weekStart; label ends on Sunday (无「北京时间」括注)", () => {
    expect(w.weekKey).toBe(beijingDayKey(w.weekStart));
    const sunday = beijingDayKey(new Date(w.weekEnd.getTime() - DAY));
    expect(beijingWeekLabel(w)).toBe(`${w.weekKey} ~ ${sunday}`);
    expect(beijingWeekLabel(w)).not.toContain("北京时间");
  });

  it("workWeekLabel ends on Friday (周一 ~ 周五,无「北京时间」括注)", () => {
    const friday = beijingDayKey(new Date(w.weekStart.getTime() + 4 * DAY));
    expect(beijingWorkWeekLabel(w)).toBe(`${w.weekKey} ~ ${friday}`);
    expect(beijingWorkWeekLabel(w)).not.toContain("北京时间");
    expect(beijingIsoDow(new Date(w.weekStart.getTime() + 4 * DAY))).toBe(5); // 确实是周五
  });

  it("stripCnTz 抹掉「（北京时间）」括注(全/半角、含嵌套),用于历史快照展示", () => {
    expect(stripCnTz("2026-06-08 ~ 2026-06-14（北京时间）")).toBe("2026-06-08 ~ 2026-06-14");
    expect(stripCnTz("2026-06-08 ~ 2026-06-14(北京时间)")).toBe("2026-06-08 ~ 2026-06-14");
    expect(stripCnTz("本周（2026-06-08 ~ 2026-06-14（北京时间)）共有 2 位成员活跃。")).toBe("本周（2026-06-08 ~ 2026-06-14）共有 2 位成员活跃。");
    expect(stripCnTz("无括注文本")).toBe("无括注文本");
  });

  it("emits 7 Monday→Sunday day keys starting at weekKey", () => {
    const keys = beijingWeekDayKeys(w);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe(w.weekKey);
    expect(keys[6]).toBe(beijingDayKey(new Date(w.weekEnd.getTime() - DAY)));
  });
});

describe("Beijing week boundary (Sun 23:30 vs Mon 00:30)", () => {
  const w = beijingWeekOf(new Date("2026-06-10T12:00:00Z"));

  it("Sunday 23:30 Beijing still belongs to the same week", () => {
    const sunNight = new Date(w.weekEnd.getTime() - 30 * 60000); // 30min before next Monday
    expect(beijingWeekOf(sunNight).weekKey).toBe(w.weekKey);
  });

  it("Monday 00:30 Beijing rolls into the next week", () => {
    const monMorning = new Date(w.weekEnd.getTime() + 30 * 60000);
    expect(beijingWeekOf(monMorning).weekKey).toBe(beijingDayKey(w.weekEnd));
  });
});

describe("previousBeijingWeek", () => {
  it("ends exactly where the current week starts", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const cur = beijingWeekOf(now);
    const prev = previousBeijingWeek(now);
    expect(prev.weekEnd.getTime()).toBe(cur.weekStart.getTime());
    expect(cur.weekStart.getTime() - prev.weekStart.getTime()).toBe(7 * DAY);
    expect(beijingIsoDow(prev.weekStart)).toBe(1);
  });
});

describe("msUntilNextBeijingMonday", () => {
  it("equals weekEnd - now and lands on a Beijing Monday", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const w = beijingWeekOf(now);
    expect(msUntilNextBeijingMonday(now)).toBe(w.weekEnd.getTime() - now.getTime());
    const nextMonday = new Date(now.getTime() + msUntilNextBeijingMonday(now));
    expect(beijingIsoDow(nextMonday)).toBe(1);
  });
});

describe("msUntilNextBeijing(任意星期几 + 时:分)", () => {
  it("周五中午 → 当天 21:00;周五 21:00 整 → 下周五(严格之后)", async () => {
    const { msUntilNextBeijing } = await import("./beijingWeek.js");
    // 2026-06-12 是周五;北京 12:00 = UTC 04:00。
    const friNoon = new Date("2026-06-12T04:00:00.000Z");
    expect(msUntilNextBeijing([5], 21, 0, friNoon)).toBe(9 * 60 * 60 * 1000);
    // 正点那一刻:下一次是 7 天后(避免同一时刻重复触发)。
    const friNine = new Date("2026-06-12T13:00:00.000Z"); // 北京 21:00
    expect(msUntilNextBeijing([5], 21, 0, friNine)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("工作日集合:周五 22:00 → 下周一 09:00;周二 08:00 → 当天 09:00", async () => {
    const { msUntilNextBeijing } = await import("./beijingWeek.js");
    const friTen = new Date("2026-06-12T14:00:00.000Z"); // 北京周五 22:00
    // 到下周一(6/15)09:00:2 天 + 11 小时。
    expect(msUntilNextBeijing([1, 2, 3, 4, 5], 9, 0, friTen)).toBe((2 * 24 + 11) * 60 * 60 * 1000);
    const tueEight = new Date("2026-06-09T00:00:00.000Z"); // 北京周二 08:00
    expect(msUntilNextBeijing([1, 2, 3, 4, 5], 9, 0, tueEight)).toBe(60 * 60 * 1000);
  });
});
