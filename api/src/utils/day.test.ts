import { describe, expect, it } from "vitest";
import { beijingDayKey, startOfBeijingDayMinus } from "./day.js";

describe("按北京日取整", () => {
  it("startOfBeijingDayMinus：返回北京 00:00，n 天前按整天回退", () => {
    // 北京 2026-06-07 00:30 = UTC 2026-06-06 16:30
    const now = new Date("2026-06-06T16:30:00Z");
    expect(startOfBeijingDayMinus(now, 0).toISOString()).toBe("2026-06-06T16:00:00.000Z");
    expect(startOfBeijingDayMinus(now, 6).toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(beijingDayKey(startOfBeijingDayMinus(now, 1))).toBe("2026-06-06");
  });
});
