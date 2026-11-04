import { describe, it, expect } from "vitest";
import { formatChatTimestamp, shouldShowChatTimestamp } from "./formatChatTime";

// 这些格式化器现在恒按北京时间展示(lib/tz.ts),与运行环境时区无关。
// 为让断言在任意 CI 时区都稳定,这里用「北京墙钟 → 绝对瞬时」构造输入:
// 北京 UTC+8,故 UTC 小时 = 北京小时 - 8(Date.UTC 会自动处理跨日进位)。
function bj(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s));
}

describe("formatChatTimestamp (北京时间)", () => {
  // 锚点:北京 2026-05-23 14:30。
  const now = bj(2026, 5, 23, 14, 30);

  it("today → HH:mm only", () => {
    expect(formatChatTimestamp(bj(2026, 5, 23, 9, 5, 7), now)).toBe("09:05");
  });

  it("yesterday → yyyy-MM-dd HH:mm", () => {
    expect(formatChatTimestamp(bj(2026, 5, 22, 23, 59, 59), now)).toBe("2026-05-22 23:59");
  });

  it("older → yyyy-MM-dd HH:mm", () => {
    expect(formatChatTimestamp(bj(2025, 1, 1, 0, 0, 0), now)).toBe("2025-01-01 00:00");
  });

  it("accepts ISO string input", () => {
    expect(formatChatTimestamp(bj(2026, 5, 23, 12, 0, 0).toISOString(), now)).toBe("12:00");
  });

  it("renders in Beijing regardless of the instant's UTC wall-clock", () => {
    // 绝对瞬时 2026-05-23T20:00:00Z = 北京次日 04:00。
    const instant = new Date("2026-05-23T20:00:00Z");
    expect(formatChatTimestamp(instant, bj(2026, 5, 24, 12, 0))).toBe("04:00");
  });

  it("invalid input → empty string (defensive)", () => {
    expect(formatChatTimestamp("not-a-date", now)).toBe("");
  });
});

describe("shouldShowChatTimestamp (北京日)", () => {
  it("first message (prev null) → show", () => {
    expect(shouldShowChatTimestamp(new Date(), null)).toBe(true);
  });

  it("gap < 10 min, same day → hide", () => {
    expect(shouldShowChatTimestamp(bj(2026, 5, 23, 10, 9, 30), bj(2026, 5, 23, 10, 0, 0))).toBe(false);
  });

  it("gap > 10 min, same day → show", () => {
    expect(shouldShowChatTimestamp(bj(2026, 5, 23, 10, 10, 1), bj(2026, 5, 23, 10, 0, 0))).toBe(true);
  });

  it("gap exactly 10 min → hide (strict >)", () => {
    expect(shouldShowChatTimestamp(bj(2026, 5, 23, 10, 10, 0), bj(2026, 5, 23, 10, 0, 0))).toBe(false);
  });

  it("different Beijing day → show even if gap is tiny", () => {
    // 北京 23:58 → 次日 00:01,仅 3 分钟但跨日;不判日就会丢失日期标记。
    expect(shouldShowChatTimestamp(bj(2026, 5, 23, 0, 1, 0), bj(2026, 5, 22, 23, 58, 0))).toBe(true);
  });

  it("invalid input → show (defensive)", () => {
    expect(shouldShowChatTimestamp("not-a-date", new Date())).toBe(true);
    expect(shouldShowChatTimestamp(new Date(), "not-a-date")).toBe(true);
  });
});
