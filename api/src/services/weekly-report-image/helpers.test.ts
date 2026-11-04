import { describe, it, expect } from "vitest";
import { esc, approxWidth, wrapText, linScale, polar, donutSlicePath } from "./helpers.js";

describe("esc", () => {
  it("转义 XML 特殊字符,防止用户内容破坏 SVG", () => {
    expect(esc(`a&b<c>"d'e`)).toBe("a&amp;b&lt;c&gt;&quot;d&#39;e");
  });
});

describe("approxWidth", () => {
  it("CJK 约 1em/字,ASCII 约 0.6em/字", () => {
    expect(approxWidth("中文", 10)).toBeCloseTo(20, 5);
    expect(approxWidth("abcde", 10)).toBeCloseTo(30, 5);
  });
});

describe("wrapText", () => {
  it("超过 maxWidth 折行;短文本不折", () => {
    expect(wrapText("短", 10, 100)).toEqual(["短"]);
    const lines = wrapText("一二三四五六七八九十", 10, 35); // 每行最多 ~3 个 CJK
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("一二三四五六七八九十");
  });
});

describe("linScale", () => {
  it("0→0,max→rangePx;max=0 时恒 0(防 NaN)", () => {
    const s = linScale(10, 100);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(5)).toBe(50);
    expect(linScale(0, 100)(0)).toBe(0);
  });
});

describe("polar / donutSlicePath", () => {
  it("polar 顶点在 12 点方向", () => {
    const p = polar(0, 0, 10, 0);
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(-10, 5);
  });
  it("donutSlicePath 产出含弧的 path d", () => {
    const d = donutSlicePath(50, 50, 40, 20, 0, 90);
    expect(d).toMatch(/^M/);
    expect(d).toContain("A");
    expect(d).toContain("Z");
  });
});
