import { describe, it, expect } from "vitest";
import { parseInline, parseLightMarkdown } from "./markdown.js";

describe("parseInline", () => {
  it("splits bold / inline code / link text / citation out of plain text", () => {
    const toks = parseInline("看 **重点** 和 `code`，详见 [文档](http://x) 还有 [#3]");
    expect(toks).toEqual([
      { t: "text", s: "看 " },
      { t: "bold", s: "重点" },
      { t: "text", s: " 和 " },
      { t: "code", s: "code" },
      { t: "text", s: "，详见 " },
      { t: "link", s: "文档" },
      { t: "text", s: " 还有 " },
      { t: "cite", s: "3" },
    ]);
  });

  it("returns a single empty text token for an empty line", () => {
    expect(parseInline("")).toEqual([{ t: "text", s: "" }]);
  });

  it("does not treat ** inside an inline-code span as bold", () => {
    expect(parseInline("`a ** b`")).toEqual([{ t: "code", s: "a ** b" }]);
  });

  it("drops image markdown ![alt](url) (images render as separate thumbnails)", () => {
    expect(parseInline("看 ![图](/uploads/x.png) 这里")).toEqual([
      { t: "text", s: "看 " },
      { t: "text", s: " 这里" },
    ]);
  });
});

describe("parseLightMarkdown", () => {
  it("classifies headings, lists, quotes, rules and paragraphs", () => {
    const blocks = parseLightMarkdown([
      "# 标题",
      "",
      "一个段落",
      "- 第一项",
      "2. 第二项",
      "> 引用语",
      "---",
    ].join("\n"));
    expect(blocks.map((b) => b.t)).toEqual(["heading", "para", "bullet", "ordered", "quote", "rule"]);
    expect(blocks[0]).toMatchObject({ t: "heading", level: 1 });
    expect(blocks[3]).toMatchObject({ t: "ordered", marker: "2." });
    expect(blocks[2]).toMatchObject({ t: "bullet", marker: "•" });
  });

  it("captures a fenced code block as raw lines (no inline parsing)", () => {
    const blocks = parseLightMarkdown(["```", "const x = **not bold**;", "line2", "```"].join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ t: "code", lines: ["const x = **not bold**;", "line2"] });
  });

  it("drops blank lines (spacing is added by the layout)", () => {
    const blocks = parseLightMarkdown("a\n\n\nb");
    expect(blocks.map((b) => b.t)).toEqual(["para", "para"]);
  });
});
