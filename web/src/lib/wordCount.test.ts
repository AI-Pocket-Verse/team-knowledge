import { describe, expect, it } from "vitest";
import { countArticleWords } from "./wordCount";

describe("countArticleWords", () => {
  it("returns 0 for empty input", () => {
    expect(countArticleWords("")).toBe(0);
  });

  it("counts CJK characters individually", () => {
    expect(countArticleWords("隐私协议草案")).toBe(6);
  });

  it("counts each Latin letter / digit (字符数, not word count)", () => {
    // Notebook(8) + ships(5) + OAuth2(6) + today(5) = 24; whitespace excluded.
    expect(countArticleWords("Notebook ships OAuth2 today")).toBe(24);
  });

  it("counts punctuation as visible characters", () => {
    // 你(1)好(1)，(1)世(1)界(1)!(1) = 6
    expect(countArticleWords("你好，世界!")).toBe(6);
  });

  it("counts heading digit content per-character (the 'test' doc case)", () => {
    // Headings of pure numbers — markers stripped, digits each count:
    // 111/222/333/444/555/666/777 = 7 × 3 = 21.
    const md = "# 111\n\n## 222\n\n#### 333\n\n#### 444\n\n##### 555\n\n###### 666\n\n777";
    expect(countArticleWords(md)).toBe(21);
  });

  it("mixes CJK chars + Latin/digit chars correctly", () => {
    // "Notebook测试 v2" → Notebook(8) + 测试(2) + v2(2) = 12
    expect(countArticleWords("Notebook测试 v2")).toBe(12);
  });

  it("excludes fenced code blocks", () => {
    const md = "前言\n\n```ts\nconst x = 1234567;\n```\n\n结语";
    // 前言 (2) + 结语 (2) = 4 — the code block doesn't contribute.
    expect(countArticleWords(md)).toBe(4);
  });

  it("excludes inline code spans", () => {
    expect(countArticleWords("调用 `someFunction()` 即可")).toBe(4);
  });

  it("drops markdown markers but keeps link text", () => {
    // `##` heading marker + `[]()` link braces + URL dropped, link text "文档"
    // kept: 标题(2) + 请参考(3) + 文档(2) + 说明(2) = 9.
    expect(countArticleWords("## 标题\n\n请参考[文档](https://example.com)说明")).toBe(9);
  });

  it("drops image syntax entirely", () => {
    expect(countArticleWords("正文 ![占位](/img.png) 末尾")).toBe(4);
  });

  it("strips bullet / ordered / blockquote markers but keeps content", () => {
    const md = "- 项一\n- 项二\n1. 编号\n> 引用文本";
    // 项一(2) + 项二(2) + 编号(2) + 引用文本(4) = 10
    expect(countArticleWords(md)).toBe(10);
  });

  it("strips emphasis markers but keeps the wrapped text", () => {
    // 粗体和斜体混排 = 7 CJK chars after the `*` markers are stripped.
    expect(countArticleWords("**粗体**和*斜体*混排")).toBe(7);
  });

  it("strips horizontal rules and table structure, keeps cell text", () => {
    const md = "标题\n\n---\n\n| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |";
    // 标题(2) + 列一(2) + 列二(2) + 甲(1) + 乙(1) = 8; rules / pipes / delimiter
    // row don't count.
    expect(countArticleWords(md)).toBe(8);
  });

  it("matches the user-visible 字数 for a typical privacy-policy paragraph", () => {
    const md = "## 1.1 账号与身份信息\n\n- 手机号（用于注册登录）\n- 账号ID、昵称、头像";
    // "1.1账号与身份信息" = 3 + 7 = 10
    // "手机号（用于注册登录）" = 3 + 1 + 6 + 1 = 11
    // "账号ID、昵称、头像" = 2 + 2 + 1 + 2 + 1 + 2 = 10
    // total = 31
    expect(countArticleWords(md)).toBe(31);
  });
});
