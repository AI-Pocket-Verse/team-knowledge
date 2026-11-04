// Regression: the Feishu importer emits ONLY Markdown-native constructs for
// unsupported content — a blockquote placeholder (+ link) for unsupported
// blocks, and plain text for underline/highlight — because Milkdown/commonmark
// renders raw HTML as literal text (confirmed in the real browser, not jsdom).
// This asserts that output mounts in the read-only editor without throwing.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MilkdownEditor } from "./MilkdownEditor";

const FEISHU_OUTPUT = [
  "正文一段。",
  "",
  "> 📌 **多维表格**(未导入) · [查看原文](https://x.feishu.cn/base/abc)",
  "",
  "带下划线和高亮的一行（样式降级为纯文本）。",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```mermaid",
  "flowchart TD",
  "  A-->B",
  "```",
  "",
  "![白板](/uploads/wb.png)",
].join("\n");

describe("MilkdownEditor — Feishu importer output (mount smoke)", () => {
  it("mounts read-only without throwing on the converter's Markdown output (incl. mermaid)", () => {
    const { container } = render(<MilkdownEditor initialMarkdown={FEISHU_OUTPUT} readOnly />);
    expect(container.querySelector(".tm-editor")).toBeTruthy();
  });

  it("mounts an editable editor without throwing on the same output", () => {
    const { container } = render(<MilkdownEditor initialMarkdown={FEISHU_OUTPUT} onChange={() => {}} />);
    expect(container.querySelector(".tm-editor")).toBeTruthy();
  });
});
