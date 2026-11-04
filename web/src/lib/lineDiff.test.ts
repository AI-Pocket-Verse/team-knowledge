import { describe, it, expect } from "vitest";
import { lineDiff, toBlocks, applySelection, countHunks } from "./lineDiff";

describe("lineDiff", () => {
  it("标记新增/删除/相等行", () => {
    const rows = lineDiff("a\nb\nc", "a\nB\nc");
    expect(rows.filter((r) => r.type === "equal").map((r) => r.text)).toEqual(["a", "c"]);
    expect(rows.some((r) => r.type === "del" && r.text === "b")).toBe(true);
    expect(rows.some((r) => r.type === "add" && r.text === "B")).toBe(true);
  });

  it("完全相同 → 全 equal", () => {
    expect(lineDiff("x\ny", "x\ny").every((r) => r.type === "equal")).toBe(true);
  });
});

describe("toBlocks / applySelection", () => {
  const before = "a\nb\nc\nd";
  const after = "a\nB\nc\nD2"; // 两处改动:b→B,d→D2

  it("归并出 context + 两个 hunk", () => {
    const blocks = toBlocks(lineDiff(before, after));
    expect(countHunks(blocks)).toBe(2);
  });

  it("全选 → 等于优化后;全不选 → 等于原文", () => {
    const blocks = toBlocks(lineDiff(before, after));
    expect(applySelection(blocks, [true, true])).toBe(after);
    expect(applySelection(blocks, [false, false])).toBe(before);
  });

  it("只选第一处 → 只应用该处改动", () => {
    const blocks = toBlocks(lineDiff(before, after));
    expect(applySelection(blocks, [true, false])).toBe("a\nB\nc\nd");
    expect(applySelection(blocks, [false, true])).toBe("a\nb\nc\nD2");
  });

  it("缺省项按采用(true)处理", () => {
    const blocks = toBlocks(lineDiff(before, after));
    expect(applySelection(blocks, [])).toBe(after);
  });
});
