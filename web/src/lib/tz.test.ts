import { describe, it, expect } from "vitest";
import { beijingParts, beijingDayKey, DISPLAY_TZ } from "./tz";

describe("tz (北京时间,与运行环境时区无关)", () => {
  it("DISPLAY_TZ is Asia/Shanghai", () => {
    expect(DISPLAY_TZ).toBe("Asia/Shanghai");
  });

  it("splits a UTC instant into Beijing wall-clock parts (UTC+8)", () => {
    // 2026-06-10T07:05:00Z = 北京 2026-06-10 15:05。
    const p = beijingParts(new Date("2026-06-10T07:05:00Z"));
    expect(p).toEqual({ year: "2026", month: "06", day: "10", hour: "15", minute: "05" });
  });

  it("rolls to the next Beijing day after 16:00Z", () => {
    // 2026-06-10T16:30:00Z = 北京 2026-06-11 00:30(跨日 + 午夜按 00 输出)。
    const p = beijingParts(new Date("2026-06-10T16:30:00Z"));
    expect(p).toEqual({ year: "2026", month: "06", day: "11", hour: "00", minute: "30" });
    expect(beijingDayKey(new Date("2026-06-10T16:30:00Z"))).toBe("2026-06-11");
  });

  it("two instants on the same Beijing day share a day key", () => {
    const a = new Date("2026-06-10T00:00:00Z"); // 北京 08:00
    const b = new Date("2026-06-10T15:59:00Z"); // 北京 23:59
    expect(beijingDayKey(a)).toBe("2026-06-10");
    expect(beijingDayKey(b)).toBe("2026-06-10");
  });
});
