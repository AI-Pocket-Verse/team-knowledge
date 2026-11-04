import { describe, it, expect } from "vitest";
import type { WeeklyReportSnapshot } from "@team-knowledge/shared";
import { buildReportSvg } from "./svg.js";

function sample(): WeeklyReportSnapshot {
  return {
    weekKey: "2026-06-08", weekStart: "2026-06-07T16:00:00.000Z", weekEnd: "2026-06-14T16:00:00.000Z",
    weekLabel: "2026-06-08 ~ 2026-06-14（北京时间）",
    summary: "本周共有 2 位成员活跃。",
    overview: { activeUsers: 2, totalDurationMin: 90, docCreate: 3, docEdit: 5, chat: 4, comment: 2, like: 6, view: 10, meeting: 0, bookmark: 1, upload: 0, totalOps: 31 },
    trends: ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14"].map((day) => ({ day, docCreate: 1, docEdit: 1, comment: 0, like: 1, chat: 1, view: 2, activeUsers: 2 })),
    composition: [{ key: "view", label: "查看文档", count: 10 }, { key: "like", label: "点赞", count: 6 }],
    userDimensions: [],
    users: [{ userId: "u1", name: "张<三>", durationMin: 60, activeDays: 5, docCreate: 2, docEdit: 3, chat: 2, comment: 1, like: 4, view: 6, contribution: 18.5, ops: 18 }],
    topContributors: [{ userId: "u1", name: "张<三>", contribution: 18.5 }],
    liveActivity: [],
  };
}

describe("buildReportSvg", () => {
  const svg = buildReportSvg(sample());
  it("是一张闭合 SVG,定宽 900", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="900"');
  });
  it("含标题/周区间与概览数值,且标题去掉「（北京时间）」括注", () => {
    expect(svg).toContain("知识库周报");
    expect(svg).toContain("2026-06-08 ~ 2026-06-14");
    expect(svg).toContain(">2<"); // 活跃用户数 2
    expect(svg).toContain("知识库周报 · 2026-06-08 ~ 2026-06-14<"); // 周区间后不再跟「（北京时间）」
  });
  it("用户名里的尖括号被转义,未原样注入", () => {
    expect(svg).toContain("张&lt;三&gt;");
    expect(svg).not.toContain("张<三>");
  });
  it("单一行为类别画成同心圆环(避免 360° 弧退化为空)", () => {
    const one = { ...sample(), composition: [{ key: "view", label: "查看文档", count: 10 }] };
    const s3 = buildReportSvg(one);
    expect(s3).toContain("<circle"); // 整圈用圆环而非退化弧;SVG 其余部分无 circle
  });
  it("空数据走极简分支不报错", () => {
    const empty = { ...sample(), overview: { ...sample().overview, activeUsers: 0 }, users: [], topContributors: [], composition: [] };
    const s2 = buildReportSvg(empty);
    expect(s2).toContain("本周暂无活动记录");
  });
});
