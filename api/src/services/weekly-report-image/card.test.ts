import { describe, it, expect } from "vitest";
import { buildWeeklyReportImageCard } from "./card.js";

interface CardShape {
  header: { title: { content: string } };
  elements: Array<{ tag: string; img_key?: string }>;
}

describe("buildWeeklyReportImageCard", () => {
  const card = buildWeeklyReportImageCard({
    weekLabel: "2026-06-08 ~ 2026-06-14（北京时间）",
    imageKey: "img_v3_abc",
  }) as CardShape;

  it("header 含周区间,且去掉「（北京时间）」", () => {
    expect(card.header.title.content).toContain("2026-06-08 ~ 2026-06-14");
    expect(card.header.title.content).not.toContain("北京时间");
  });
  it("含 img 元素(img_key),不含任何按钮", () => {
    const img = card.elements.find((e) => e.tag === "img");
    expect(img?.img_key).toBe("img_v3_abc");
    expect(card.elements.find((e) => e.tag === "action")).toBeUndefined();
  });
});
