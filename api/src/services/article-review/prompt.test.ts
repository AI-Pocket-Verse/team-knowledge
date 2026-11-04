import { describe, it, expect } from "vitest";
import { buildReviewUserMessage, buildOptimizeUserMessage, sanitizeOptimizedMarkdown } from "./prompt.js";

describe("sanitizeOptimizedMarkdown", () => {
  it("剥掉整篇外层 ``` 围栏", () => {
    expect(sanitizeOptimizedMarkdown("```markdown\n# 标题\n正文\n```")).toBe("# 标题\n正文");
    expect(sanitizeOptimizedMarkdown("```\n纯文本\n```")).toBe("纯文本");
  });
  it("不动正文内部合法的代码块", () => {
    const s = "# 标题\n\n```js\nconst a = 1;\n```\n\n结尾";
    expect(sanitizeOptimizedMarkdown(s)).toBe(s);
  });
  it("无围栏时仅 trim", () => {
    expect(sanitizeOptimizedMarkdown("  正文  ")).toBe("正文");
  });
});

describe("article-review prompts", () => {
  it("review user message 含本篇标题/正文 + 相关文档摘要", () => {
    const msg = buildReviewUserMessage(
      { title: "请假流程", body: "正文内容" },
      [{ title: "考勤制度", snippet: "考勤摘要" }],
    );
    expect(msg).toContain("请假流程");
    expect(msg).toContain("正文内容");
    expect(msg).toContain("考勤制度");
    expect(msg).toContain("考勤摘要");
    // 标题不得渲染成 markdown 标题(`## 标题`),否则与正文自带 H1 形成层级倒置 → 误报。
    expect(msg).not.toContain(`## 请假流程`);
  });

  it("无相关文档时也能生成(不含『其它相关文档』段)", () => {
    const msg = buildReviewUserMessage({ title: "T", body: "B" }, []);
    expect(msg).toContain("T");
    expect(msg).not.toContain("其它相关文档");
  });

  it("optimize user message 含问题清单", () => {
    const msg = buildOptimizeUserMessage(
      { title: "T", body: "B" },
      [{ category: "logic", severity: "high", problem: "矛盾", suggestion: "改", hash: "h1" }],
    );
    expect(msg).toContain("矛盾");
    expect(msg).toContain("B");
  });
});
