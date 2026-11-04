import { describe, it, expect } from "vitest";
import { placeMenu } from "./useAnchoredMenu";

const VP = { width: 1000, height: 800 };
const anchor = (top: number, bottom: number, left: number, right: number) => ({ top, bottom, left, right });

describe("placeMenu", () => {
  it("opens below the anchor when it fits", () => {
    const p = placeMenu(anchor(100, 120, 50, 90), { width: 160, height: 100 }, VP);
    expect(p.top).toBe(124); // bottom + gap(4)
    expect(p.left).toBe(50); // align left = anchor.left
    expect(p.maxHeight).toBeUndefined();
  });

  it("flips above when the menu would clip the viewport bottom", () => {
    const p = placeMenu(anchor(760, 780, 50, 90), { width: 160, height: 100 }, VP);
    expect(p.top).toBe(656); // anchor.top - gap - height = 760-4-100
    expect(p.maxHeight).toBeUndefined();
  });

  it("right-align clamps so the menu stays inside the right edge", () => {
    const p = placeMenu(anchor(100, 120, 955, 995), { width: 160, height: 100 }, VP, { align: "right" });
    // 995-160=835 但右侧留白后最大 left = 1000-160-8 = 832
    expect(p.left).toBe(832);
  });

  it("clamps to the left padding when the anchor is near the left edge", () => {
    const p = placeMenu(anchor(100, 120, 60, 100), { width: 160, height: 100 }, VP, { align: "right" });
    expect(p.left).toBe(8); // 100-160=-60 → 夹到 pad
  });

  it("falls back to scroll (maxHeight) below when neither side fully fits and below is larger", () => {
    const p = placeMenu(anchor(300, 320, 50, 90), { width: 160, height: 900 }, VP);
    expect(p.top).toBe(324);
    expect(p.maxHeight).toBe(800 - 320 - 4 - 8); // spaceBelow
  });

  it("falls back to scroll above when the upper side is larger", () => {
    const p = placeMenu(anchor(700, 720, 50, 90), { width: 160, height: 900 }, VP);
    const spaceAbove = 700 - 4 - 8;
    expect(p.maxHeight).toBe(spaceAbove);
    expect(p.top).toBe(8); // 顶到上沿 pad
  });
});
