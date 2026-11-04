import { describe, it, expect } from "vitest";
import { formatTimestamp } from "./format";

describe("formatTimestamp (北京时间,与运行环境时区无关)", () => {
  it("formats a UTC instant as yyyy-MM-dd HH:mm:ss in Beijing time", () => {
    // 2026-06-10T07:05:30Z = 北京 2026-06-10 15:05:30。
    expect(formatTimestamp("2026-06-10T07:05:30Z")).toBe("2026-06-10 15:05:30");
  });

  it("rolls to the next Beijing day when UTC crosses 16:00Z", () => {
    // 2026-06-10T16:03:09Z = 北京 2026-06-11 00:03:09。
    expect(formatTimestamp("2026-06-10T16:03:09Z")).toBe("2026-06-11 00:03:09");
  });

  it("pads single-digit fields to two digits", () => {
    // 2026-01-05T00:01:07Z = 北京 2026-01-05 08:01:07。
    expect(formatTimestamp("2026-01-05T00:01:07Z")).toBe("2026-01-05 08:01:07");
  });
});
