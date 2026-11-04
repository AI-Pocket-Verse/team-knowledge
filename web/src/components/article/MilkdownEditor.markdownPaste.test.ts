// Unit tests for the markdown-detection heuristic that drives the
// (2a, Fix D) paste branch in MilkdownEditor. We can't easily
// exercise the full ProseMirror clipboard pipeline from jsdom, but
// we can pin the detector that decides whether to invoke it.
import { describe, expect, it } from "vitest";
import {
  looksLikeMarkdown,
  looksLikeStructuralMarkdown,
} from "./MilkdownEditor";

describe("looksLikeMarkdown", () => {
  it("returns false for empty / undefined-ish input", () => {
    expect(looksLikeMarkdown("")).toBe(false);
    expect(looksLikeMarkdown("   ")).toBe(false);
  });

  it("returns false for plain prose with no structural syntax", () => {
    expect(looksLikeMarkdown("Just a sentence.")).toBe(false);
    expect(looksLikeMarkdown("Multiple lines\nof plain text\nwithout any md.")).toBe(false);
  });

  it("recognizes headings", () => {
    expect(looksLikeMarkdown("# Title")).toBe(true);
    expect(looksLikeMarkdown("intro\n\n## Section\nbody")).toBe(true);
    expect(looksLikeMarkdown("###### h6")).toBe(true);
  });

  it("recognizes fenced code blocks", () => {
    expect(looksLikeMarkdown("```ts\nconst x = 1;\n```")).toBe(true);
  });

  it("recognizes bullet and ordered lists", () => {
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("* alpha\n* beta")).toBe(true);
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
  });

  it("recognizes blockquotes and tables", () => {
    expect(looksLikeMarkdown("> quoted")).toBe(true);
    expect(looksLikeMarkdown("| col | col |\n| --- | --- |")).toBe(true);
  });

  it("recognizes links and images", () => {
    expect(looksLikeMarkdown("see [docs](https://x.y)")).toBe(true);
    expect(looksLikeMarkdown("![alt](https://x.y/img.png)")).toBe(true);
  });

  it("does not false-positive on `#` mid-line (only line-start headings)", () => {
    expect(looksLikeMarkdown("call #foo() to bar")).toBe(false);
  });

  it("recognizes structural prose pastes (heading + bullets, the user's case)", () => {
    const sample = `## 1.1 账号与身份信息\n\n- 手机号（用于注册登录、找回账号，如本版本启用该能力）\n- 账号ID、昵称、头像（用户可选填写或系统生成）\n\n## 1.2 设备与日志信息`;
    expect(looksLikeMarkdown(sample)).toBe(true);
  });
});

describe("looksLikeStructuralMarkdown", () => {
  it("recognizes the same block-level signals as looksLikeMarkdown", () => {
    expect(looksLikeStructuralMarkdown("# h")).toBe(true);
    expect(looksLikeStructuralMarkdown("- a\n- b")).toBe(true);
    expect(looksLikeStructuralMarkdown("```\nx\n```")).toBe(true);
    expect(looksLikeStructuralMarkdown("> quote")).toBe(true);
    expect(looksLikeStructuralMarkdown("| a | b |")).toBe(true);
    expect(looksLikeStructuralMarkdown("1. one")).toBe(true);
  });

  it("returns false for inline-only markdown signals (safer for code)", () => {
    // `[a](b)` and `![alt](url)` deliberately don't count here, so
    // pasting JS like `arr[0](x)` won't be re-routed as markdown.
    expect(looksLikeStructuralMarkdown("see [docs](https://x.y)")).toBe(false);
    expect(looksLikeStructuralMarkdown("![alt](https://x.y/img.png)")).toBe(
      false,
    );
    expect(looksLikeStructuralMarkdown("function foo() { return arr[0](x); }")).toBe(
      false,
    );
  });

  it("matches the user's privacy-policy paste (regression)", () => {
    const sample = `## 1.1 账号与身份信息\n\n- 手机号\n- 账号ID`;
    expect(looksLikeStructuralMarkdown(sample)).toBe(true);
  });
});

