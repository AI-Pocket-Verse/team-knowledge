import { describe, it, expect } from "vitest";
import { parseReviewFindings, hashReviewFindings, reviewFindingHash } from "./findings.js";

describe("parseReviewFindings", () => {
  it("解析裸 JSON,过滤非法类别/缺问题,补默认 severity", () => {
    const txt = JSON.stringify({
      findings: [
        { category: "logic", severity: "high", problem: "前后步骤矛盾", suggestion: "统一顺序" },
        { category: "bogus", problem: "x" },          // 非法类别 → 丢
        { category: "format", problem: "" },           // 缺问题 → 丢
        { category: "consistency", problem: "与《A》口径不一致" }, // 无 severity → "med",无 suggestion → ""
      ],
    });
    const f = parseReviewFindings(txt);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ category: "logic", severity: "high", problem: "前后步骤矛盾" });
    expect(f[1]).toMatchObject({ category: "consistency", severity: "med", suggestion: "" });
  });

  it("剥 ```json 代码块 + 前后解释文字", () => {
    const txt = "结果:\n```json\n{\"findings\":[{\"category\":\"clarity\",\"severity\":\"low\",\"problem\":\"表述含糊\",\"suggestion\":\"举例说明\"}]}\n```\n完";
    expect(parseReviewFindings(txt)).toHaveLength(1);
  });

  it("非 JSON / 空 → 空数组(不抛)", () => {
    expect(parseReviewFindings("模型摆烂")).toEqual([]);
    expect(parseReviewFindings("")).toEqual([]);
  });
});

describe("reviewFindingHash / hashReviewFindings", () => {
  it("hash 只取 category+归一化 problem(空白折叠),severity/suggestion 不影响身份", () => {
    const a = reviewFindingHash({ category: "logic", problem: "步骤  矛盾" });
    const b = reviewFindingHash({ category: "logic", problem: "步骤 矛盾" });
    expect(a).toBe(b);
  });
  it("按 hash 去重并附 hash", () => {
    const out = hashReviewFindings([
      { category: "logic", severity: "high", problem: "P", suggestion: "" },
      { category: "logic", severity: "med", problem: "P", suggestion: "" }, // 同 hash → 去重
      { category: "format", severity: "low", problem: "Q", suggestion: "" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].hash).toHaveLength(12);
  });
});
