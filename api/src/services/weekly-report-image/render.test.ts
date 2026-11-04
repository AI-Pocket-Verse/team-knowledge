import { describe, it, expect } from "vitest";
import type { WeeklyReportSnapshot } from "@team-knowledge/shared";
import { renderReportPng } from "./render.js";

function sample(): WeeklyReportSnapshot {
  return {
    weekKey: "2026-06-08", weekStart: "2026-06-07T16:00:00.000Z", weekEnd: "2026-06-14T16:00:00.000Z",
    weekLabel: "2026-06-08 ~ 2026-06-14（北京时间）",
    summary: "本周共有 2 位成员活跃,累计在线约 1.5 小时。",
    overview: { activeUsers: 2, totalDurationMin: 90, docCreate: 3, docEdit: 5, chat: 4, comment: 2, like: 6, view: 10, meeting: 0, bookmark: 1, upload: 0, totalOps: 31 },
    trends: ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14"].map((day) => ({ day, docCreate: 1, docEdit: 1, comment: 0, like: 1, chat: 1, view: 2, activeUsers: 2 })),
    composition: [{ key: "view", label: "查看文档", count: 10 }, { key: "like", label: "点赞", count: 6 }],
    userDimensions: [],
    users: [{ userId: "u1", name: "张三", durationMin: 60, activeDays: 5, docCreate: 2, docEdit: 3, chat: 2, comment: 1, like: 4, view: 6, contribution: 18.5, ops: 18 }],
    topContributors: [{ userId: "u1", name: "张三", contribution: 18.5 }],
    liveActivity: [],
  };
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("renderReportPng", () => {
  it("resvg + 内置字体渲出合法 PNG,宽 = 900×2", async () => {
    const png = await renderReportPng(sample());
    expect(png.length).toBeGreaterThan(2000); // 渲染出实际像素(非空白/极小)
    expect(png.subarray(0, 8).equals(PNG_SIG)).toBe(true); // PNG 魔数
    expect(png.readUInt32BE(16)).toBe(900 * 2); // IHDR width = fitTo 宽
  });
});
