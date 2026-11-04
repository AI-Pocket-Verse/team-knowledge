import { describe, it, expect } from "vitest";
import { normalizeBlocks } from "./feishuNormalize.js";

// NOTE: these synthetic blocks validate the MAPPING LOGIC (block_type → DocNode
// shape, text styles → inline flags). The exact block_type NUMBERS are confirmed
// against a real captured document in the Feishu integration step (plan 0.2);
// a real-fixture "does not throw" regression test is added there.

describe("normalizeBlocks", () => {
  it("maps a heading1 block under the root page to a heading DocNode", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["h"] },
      { block_id: "h", block_type: 3, heading1: { elements: [{ text_run: { content: "T", text_element_style: {} } }] } },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "heading", level: 1 });
    expect(nodes[0].inlines?.[0]).toMatchObject({ kind: "text", text: "T" });
  });

  it("caps heading level metadata at the real value (level 9)", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["h"] },
      { block_id: "h", block_type: 11, heading9: { elements: [{ text_run: { content: "deep", text_element_style: {} } }] } },
    ]);
    expect(nodes[0]).toMatchObject({ type: "heading", level: 9 });
  });

  it("maps bold + link text element styles", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["t"] },
      {
        block_id: "t",
        block_type: 2,
        text: {
          elements: [
            { text_run: { content: "粗", text_element_style: { bold: true } } },
            { text_run: { content: "链", text_element_style: { link: { url: "https%3A%2F%2Fe.com" } } } },
          ],
        },
      },
    ]);
    expect(nodes[0].inlines?.[0]).toMatchObject({ kind: "text", text: "粗", bold: true });
    expect(nodes[0].inlines?.[1]).toMatchObject({ kind: "text", link: "https://e.com" });
  });

  it("maps list + todo + divider + image", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["b", "o", "d", "td", "div", "img"] },
      { block_id: "b", block_type: 12, bullet: { elements: [{ text_run: { content: "a", text_element_style: {} } }] } },
      { block_id: "o", block_type: 13, ordered: { elements: [{ text_run: { content: "b", text_element_style: {} } }] } },
      { block_id: "td", block_type: 17, todo: { style: { done: true }, elements: [{ text_run: { content: "c", text_element_style: {} } }] } },
      { block_id: "div", block_type: 22, divider: {} },
      { block_id: "img", block_type: 27, image: { token: "TOKEN123" } },
    ]);
    const types = nodes.map((n) => n.type);
    expect(types).toEqual(["bullet", "ordered", "todo", "divider", "image"]);
    expect(nodes[2]).toMatchObject({ type: "todo", done: true });
    expect(nodes[4]).toMatchObject({ type: "image", imageToken: "TOKEN123" });
  });

  it("extracts a bitable embed (block_type 18) token into app_token + table_id", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["bt"] },
      { block_id: "bt", block_type: 18, bitable: { token: "AppToken123_tblABC" } },
    ]);
    expect(nodes[0]).toMatchObject({
      type: "unsupported",
      unsupportedKind: "bitable",
      embed: { kind: "bitable", appToken: "AppToken123", tableId: "tblABC" },
    });
  });

  it("extracts sheet (30), whiteboard/board (43) and file (23) embeds", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["s", "b", "f"] },
      { block_id: "s", block_type: 30, sheet: { token: "shtABC_0b3d1a" } },
      { block_id: "b", block_type: 43, board: { token: "wbcnXYZ" } },
      { block_id: "f", block_type: 23, file: { token: "boxcn1", name: "report.pdf" } },
    ]);
    expect(nodes[0].embed).toEqual({ kind: "sheet", sheetToken: "shtABC", sheetId: "0b3d1a" });
    expect(nodes[1].embed).toEqual({ kind: "whiteboard", token: "wbcnXYZ" });
    expect(nodes[2].embed).toEqual({ kind: "file", token: "boxcn1", name: "report.pdf" });
  });

  it("recurses nested list children with increasing depth (no content dropped)", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["b1"] },
      { block_id: "b1", block_type: 12, bullet: { elements: [{ text_run: { content: "parent", text_element_style: {} } }] }, children: ["b2"] },
      { block_id: "b2", block_type: 12, bullet: { elements: [{ text_run: { content: "child", text_element_style: {} } }] } },
    ]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ type: "bullet", depth: 0 });
    expect(nodes[1]).toMatchObject({ type: "bullet", depth: 1 });
    expect(nodes[1].inlines?.[0]).toMatchObject({ text: "child" });
  });

  it("mindnote (29) and diagram (21) are placeholder-only (no embed)", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["m", "d"] },
      { block_id: "m", block_type: 29, mindnote: { token: "x" } },
      { block_id: "d", block_type: 21, diagram: {} },
    ]);
    expect(nodes[0]).toMatchObject({ type: "unsupported", unsupportedKind: "mindnote" });
    expect(nodes[0].embed).toBeUndefined();
    expect(nodes[1]).toMatchObject({ type: "unsupported", unsupportedKind: "diagram" });
    expect(nodes[1].embed).toBeUndefined();
  });

  it("maps an unknown block_type to a generic unsupported node (never throws)", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["x"] },
      { block_id: "x", block_type: 9999, mystery: {} },
    ]);
    expect(nodes[0].type).toBe("unsupported");
  });

  it("does not emit a non-string code language (avoids ```<number> fences)", () => {
    const nodes = normalizeBlocks([
      { block_id: "p", block_type: 1, page: {}, children: ["c"] },
      { block_id: "c", block_type: 14, code: { style: { language: 49 }, elements: [{ text_run: { content: "x=1", text_element_style: {} } }] } },
    ]);
    expect(nodes[0]).toMatchObject({ type: "code", text: "x=1" });
    expect(nodes[0].language).toBe("");
  });
});
