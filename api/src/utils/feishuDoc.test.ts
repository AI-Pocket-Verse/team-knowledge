import { describe, it, expect } from "vitest";
import { convertDoc, buildGfmTable, type DocNode } from "./feishuDoc.js";

const OPTS = {
  sourceUrl: "https://x.feishu.cn/docx/D1",
  resolveImage: async () => "/uploads/img-1.png",
};

describe("convertDoc — basic blocks", () => {
  it("headings cap at H6 and render inline styles", async () => {
    const nodes: DocNode[] = [
      { type: "heading", level: 1, inlines: [{ kind: "text", text: "标题" }] },
      { type: "heading", level: 8, inlines: [{ kind: "text", text: "深标题" }] },
      {
        type: "paragraph",
        inlines: [
          { kind: "text", text: "粗", bold: true },
          { kind: "text", text: "斜", italic: true },
          { kind: "text", text: "码", code: true },
          { kind: "text", text: "链", link: "https://e.com" },
        ],
      },
    ];
    const { markdown } = await convertDoc(nodes, { ...OPTS, unsupportedMode: "placeholder" });
    expect(markdown).toContain("# 标题");
    expect(markdown).toContain("###### 深标题");
    expect(markdown).toContain("**粗**");
    expect(markdown).toContain("*斜*");
    expect(markdown).toContain("`码`");
    expect(markdown).toContain("[链](https://e.com)");
  });

  it("lists (bullet/ordered/todo) and code/quote/divider", async () => {
    const nodes: DocNode[] = [
      { type: "bullet", inlines: [{ kind: "text", text: "a" }] },
      { type: "ordered", inlines: [{ kind: "text", text: "b" }] },
      { type: "todo", done: true, inlines: [{ kind: "text", text: "c" }] },
      { type: "code", language: "ts", text: "const x = 1" },
      { type: "quote", inlines: [{ kind: "text", text: "q" }] },
      { type: "divider" },
    ];
    const { markdown } = await convertDoc(nodes, { ...OPTS, unsupportedMode: "placeholder" });
    expect(markdown).toContain("- a");
    expect(markdown).toContain("1. b");
    expect(markdown).toContain("- [x] c");
    expect(markdown).toContain("```ts\nconst x = 1\n```");
    expect(markdown).toContain("> q");
    expect(markdown).toContain("---");
  });

  it("image uses the resolved /uploads URL", async () => {
    const { markdown } = await convertDoc([{ type: "image", imageToken: "tok", imageAlt: "图" }], {
      ...OPTS,
      unsupportedMode: "placeholder",
    });
    expect(markdown).toContain("![图](/uploads/img-1.png)");
  });

  it("image resolve failure → placeholder + warning, not a throw", async () => {
    const { markdown, report } = await convertDoc([{ type: "image", imageToken: "tok" }], {
      ...OPTS,
      unsupportedMode: "placeholder",
      resolveImage: async () => null,
    });
    expect(markdown).toContain("图片导入失败");
    expect(report.warnings.length).toBe(1);
  });

  it("renders a simple GFM table", async () => {
    const nodes: DocNode[] = [
      {
        type: "table",
        table: {
          complex: false,
          rows: [
            [[{ kind: "text", text: "A" }], [{ kind: "text", text: "B" }]],
            [[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }]],
          ],
        },
      },
    ];
    const { markdown } = await convertDoc(nodes, { ...OPTS, unsupportedMode: "placeholder" });
    expect(markdown).toContain("| A | B |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| 1 | 2 |");
  });
});

describe("convertDoc — unsupported handling", () => {
  const embed: DocNode = {
    type: "unsupported",
    unsupportedKind: "bitable",
    sourceUrl: "https://x.feishu.cn/base/B1",
  };

  it("placeholder mode → WYSIWYG-friendly markdown blockquote (no raw HTML), counted", async () => {
    const { markdown, report } = await convertDoc([embed], { ...OPTS, unsupportedMode: "placeholder" });
    expect(markdown).toContain("> 📌");
    expect(markdown).toContain("多维表格");
    expect(markdown).toContain("[查看原文](https://x.feishu.cn/base/B1)");
    expect(markdown).not.toContain("<div");
    expect(report.placeholderBlocks).toBe(1);
    expect(report.droppedBlocks).toBe(0);
  });

  it("drop mode → omitted, counted as dropped", async () => {
    const { markdown, report } = await convertDoc([embed], { ...OPTS, unsupportedMode: "drop" });
    expect(markdown).not.toContain("多维表格");
    expect(report.droppedBlocks).toBe(1);
    expect(report.placeholderBlocks).toBe(0);
  });

  it("inline underline/highlight degrade to plain text (no raw HTML) in both modes", async () => {
    const node: DocNode = {
      type: "paragraph",
      inlines: [
        { kind: "text", text: "下", underline: true },
        { kind: "text", text: "亮", highlight: true },
      ],
    };
    for (const mode of ["placeholder", "drop"] as const) {
      const md = (await convertDoc([node], { ...OPTS, unsupportedMode: mode })).markdown;
      expect(md).toContain("下");
      expect(md).toContain("亮");
      expect(md).not.toContain("<u>");
      expect(md).not.toContain("<mark>");
    }
  });

  it("complex table routes through the unsupported branch", async () => {
    const complex: DocNode = { type: "table", table: { complex: true, rows: [] } };
    expect((await convertDoc([complex], { ...OPTS, unsupportedMode: "drop" })).report.droppedBlocks).toBe(1);
    expect((await convertDoc([complex], { ...OPTS, unsupportedMode: "placeholder" })).report.placeholderBlocks).toBe(1);
  });
});

describe("convertDoc — resolvable embeds (resolveEmbed)", () => {
  it("uses the resolveEmbed result in place of the placeholder (counts as converted)", async () => {
    const node: DocNode = {
      type: "unsupported",
      unsupportedKind: "whiteboard",
      embed: { kind: "whiteboard", token: "wb1" },
    };
    const { markdown, report } = await convertDoc([node], {
      ...OPTS,
      unsupportedMode: "placeholder",
      resolveEmbed: async (e) => (e.kind === "whiteboard" ? "![白板](/uploads/wb.png)" : null),
    });
    expect(markdown).toContain("![白板](/uploads/wb.png)");
    expect(markdown).not.toContain("📌");
    expect(report.converted).toBeGreaterThan(0);
    expect(report.placeholderBlocks).toBe(0);
  });

  it("falls back to placeholder when resolveEmbed returns null", async () => {
    const node: DocNode = {
      type: "unsupported",
      unsupportedKind: "bitable",
      embed: { kind: "bitable", appToken: "a", tableId: "t" },
    };
    const { markdown, report } = await convertDoc([node], {
      ...OPTS,
      unsupportedMode: "placeholder",
      resolveEmbed: async () => null,
    });
    expect(markdown).toContain("📌");
    expect(report.placeholderBlocks).toBe(1);
  });

  it("drop mode still drops an embed that fails to resolve", async () => {
    const node: DocNode = { type: "unsupported", unsupportedKind: "sheet", embed: { kind: "sheet", sheetToken: "s", sheetId: "0" } };
    const { report } = await convertDoc([node], { ...OPTS, unsupportedMode: "drop", resolveEmbed: async () => null });
    expect(report.droppedBlocks).toBe(1);
  });
});

describe("buildGfmTable", () => {
  it("builds a GFM table and pads ragged rows to the widest", () => {
    const md = buildGfmTable([
      ["A", "B"],
      ["1"],
      ["x", "y"],
    ]);
    expect(md).toContain("| A | B |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 |  |");
    expect(md).toContain("| x | y |");
  });

  it("escapes pipes and newlines in cells", () => {
    expect(buildGfmTable([["a|b", "c\nd"]])).toContain("a\\|b | c d");
  });
});

describe("convertDoc — robustness fixes", () => {
  it("uses a longer fence when the code body contains a triple-backtick run", async () => {
    const { markdown } = await convertDoc([{ type: "code", language: "md", text: "a ``` b" }], {
      ...OPTS,
      unsupportedMode: "placeholder",
    });
    expect(markdown).toContain("````md\na ``` b\n````");
  });

  it("indents nested list items by depth", async () => {
    const { markdown } = await convertDoc(
      [
        { type: "bullet", depth: 0, inlines: [{ kind: "text", text: "p" }] },
        { type: "bullet", depth: 1, inlines: [{ kind: "text", text: "c" }] },
      ],
      { ...OPTS, unsupportedMode: "placeholder" },
    );
    expect(markdown).toContain("- p");
    expect(markdown).toContain("  - c");
  });

  it("drops dangerous link schemes but keeps the text", async () => {
    const { markdown } = await convertDoc(
      [{ type: "paragraph", inlines: [{ kind: "text", text: "x", link: "javascript:alert(1)" }] }],
      { ...OPTS, unsupportedMode: "placeholder" },
    );
    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("x");
  });

  it("warns when a resolvable embed fails to resolve (not silently placeholdered)", async () => {
    const { report } = await convertDoc(
      [{ type: "unsupported", unsupportedKind: "bitable", embed: { kind: "bitable", appToken: "a", tableId: "t" } }],
      { ...OPTS, unsupportedMode: "placeholder", resolveEmbed: async () => null },
    );
    expect(report.warnings.length).toBe(1);
    expect(report.placeholderBlocks).toBe(1);
  });
});
