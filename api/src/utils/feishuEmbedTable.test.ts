import { describe, it, expect } from "vitest";
import { cellText, bitableToRows, sheetToRows, extractMermaid } from "./feishuEmbedTable.js";

describe("cellText", () => {
  it("joins text segments", () => {
    expect(cellText([{ text: "a" }, { text: "b" }])).toBe("a, b");
  });
  it("reads option/person name", () => {
    expect(cellText({ name: "张三" })).toBe("张三");
  });
  it("stringifies numbers/booleans; empty for null", () => {
    expect(cellText(42)).toBe("42");
    expect(cellText(true)).toBe("true");
    expect(cellText(null)).toBe("");
  });
  it("passes through plain strings", () => {
    expect(cellText("hello")).toBe("hello");
  });
});

describe("bitableToRows", () => {
  it("builds header + rows and flags truncation at the cap", () => {
    const fields = ["名称", "数量"];
    const records = [
      { 名称: "苹果", 数量: 3 },
      { 名称: "梨", 数量: 5 },
    ];
    const { rows, truncated } = bitableToRows(fields, records, 1);
    expect(rows[0]).toEqual(["名称", "数量"]);
    expect(rows[1]).toEqual(["苹果", "3"]);
    expect(rows.length).toBe(2); // header + 1 (capped at maxRows=1)
    expect(truncated).toBe(true);
  });
  it("no truncation when under the cap", () => {
    const { truncated } = bitableToRows(["a"], [{ a: "1" }], 10);
    expect(truncated).toBe(false);
  });
});

describe("sheetToRows", () => {
  it("stringifies cells and drops trailing empty rows", () => {
    expect(sheetToRows([["A", "B"], [1, 2], ["", ""]])).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });
});

describe("extractMermaid", () => {
  it("finds a mermaid source in a node field", () => {
    expect(extractMermaid([{ type: "x" }, { diagram_syntax: "flowchart TD\n A-->B" }])).toBe(
      "flowchart TD\n A-->B",
    );
  });
  it("finds it nested one level deep", () => {
    expect(extractMermaid([{ data: { content: "sequenceDiagram\n A->>B: hi" } }])).toContain(
      "sequenceDiagram",
    );
  });
  it("returns null for a freehand (non-diagram) board", () => {
    expect(extractMermaid([{ type: "rect", text: "hello" }])).toBeNull();
  });
});
