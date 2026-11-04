import { describe, it, expect } from "vitest";
import { listScenarios } from "../notify-test/index.js";
import { __testing } from "../notify-cron/index.js";
import { SCENARIO_KEYS, DEFAULT_SCHEDULES } from "../notify-config/index.js";

describe("kb_weekly_report 注册", () => {
  it("在 SCENARIO_KEYS 与默认时刻里(周一 09:00)", () => {
    expect(SCENARIO_KEYS).toContain("kb_weekly_report");
    expect(DEFAULT_SCHEDULES.kb_weekly_report).toEqual({ weekdays: [1], hour: 9, minute: 0, repeat: true });
  });
  it("在 cron JOBS 里(进程内定时器)", () => {
    expect(__testing.JOBS.some((j) => j.key === "kb_weekly_report")).toBe(true);
  });
  it("listScenarios 含该场景且为 cron", async () => {
    const list = await listScenarios();
    const s = list.find((x) => x.key === "kb_weekly_report");
    expect(s).toBeTruthy();
    expect(s!.triggerType).toBe("cron");
  });
});
