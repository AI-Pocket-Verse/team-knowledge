import { describe, it, expect } from "vitest";
import { hasRetrievableContent, RETRIEVABLE_MIN_CHARS } from "./retrievable.js";

describe("hasRetrievableContent", () => {
  it("阈值常量为 10", () => {
    expect(RETRIEVABLE_MIN_CHARS).toBe(10);
  });
  it("空串 / 纯空白 → false", () => {
    expect(hasRetrievableContent("")).toBe(false);
    expect(hasRetrievableContent("   \n\t  ")).toBe(false);
  });
  it("纯 markdown 符号 / 空标题 → false", () => {
    expect(hasRetrievableContent("# \n\n---\n\n> ")).toBe(false);
    expect(hasRetrievableContent("``````")).toBe(false);
  });
  it("正文不足 10 字 → false", () => {
    expect(hasRetrievableContent("# 标题\n\n短")).toBe(false); // “标题短” = 3 字
  });
  it("正文达到 10 字 → true", () => {
    expect(hasRetrievableContent("这是一段足够长的正文内容")).toBe(true);
  });
  it("只剥图片/链接的 URL，保留可见文字", () => {
    // 链接整体剔除从严:可见文字也被剔除 → 仅 URL 的文档判为无内容
    expect(hasRetrievableContent("![](/uploads/a.png) [](/d/x)")).toBe(false);
    // 链接文字 + 充足正文 → true
    expect(hasRetrievableContent("参见 [文档](/d/x) 里的完整说明和上下文")).toBe(true);
  });
});
