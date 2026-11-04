import { describe, it, expect } from "vitest";
import { parseFindings, dedupeFindings, findingHash, renderFindings, bigrams, jaccard, buildFuzzyRefs, isFuzzyAcked, type AuditFinding } from "./findings.js";

describe("parseFindings", () => {
  it("解析裸 JSON,过滤非法类别 / 缺问题的条目", () => {
    const txt = JSON.stringify({
      findings: [
        { category: "inconsistency", docTitle: "A、B", problem: "对试用期说法不一致", suggestion: "统一为 3 个月" },
        { category: "bogus", docTitle: "C", problem: "x" }, // 非法类别 → 丢
        { category: "logic", docTitle: "D", problem: "" }, // 缺问题 → 丢
        { category: "optimize", problem: "步骤过时" }, // 缺 docTitle 可以,无 suggestion → ""
      ],
    });
    const f = parseFindings(txt);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ category: "inconsistency", problem: "对试用期说法不一致" });
    expect(f[1]).toMatchObject({ category: "optimize", docTitle: "", suggestion: "" });
  });

  it("剥 ```json 代码块 + 前后解释文字", () => {
    const txt = "好的,结果如下:\n```json\n{\"findings\":[{\"category\":\"logic\",\"docTitle\":\"E\",\"problem\":\"步骤错乱\",\"suggestion\":\"调整顺序\"}]}\n```\n以上。";
    expect(parseFindings(txt)).toHaveLength(1);
  });

  it("非 JSON / 空 → 空数组(不抛)", () => {
    expect(parseFindings("模型今天不想干活")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
    expect(parseFindings("{坏 json")).toEqual([]);
  });
});

describe("findingHash / dedupeFindings", () => {
  const a: AuditFinding = { category: "logic", docTitle: "报销流程", problem: "步骤 3 与 4 矛盾", suggestion: "改" };
  it("同类别+文档+问题(空白归一)→ 同 hash", () => {
    const b: AuditFinding = { ...a, problem: "步骤 3  与 4   矛盾", suggestion: "别的建议" };
    expect(findingHash(a)).toBe(findingHash(b)); // suggestion 不进 hash;问题空白折叠后相同
  });
  it("dedupe 去掉重复 hash", () => {
    const out = dedupeFindings([a, { ...a }, { ...a, problem: "另一个问题" }]);
    expect(out).toHaveLength(2);
    expect(out[0].hash).toBeTruthy();
  });
});

describe("模糊指纹(抗改写硬过滤)", () => {
  it("bigram / jaccard 基本行为", () => {
    expect(jaccard(bigrams("会员协议数据保留期限不一致"), bigrams("会员协议数据保留期限不一致"))).toBe(1);
    expect(jaccard(bigrams("完全不同的问题甲"), bigrams("毫不相干的另一件事乙"))).toBeLessThan(0.2);
    expect(jaccard(new Set<string>(), bigrams("x"))).toBe(0); // 空集 → 0
  });

  it("同一问题换措辞 → 命中已确认(抗改写)", () => {
    const acked: AuditFinding[] = [
      { category: "inconsistency", docTitle: "会员协议、隐私政策", problem: "关于数据保留期限的表述不一致", suggestion: "统一" },
    ];
    const refs = buildFuzzyRefs(acked);
    // 换「表述→说法」「和→与」这类改写,hash 会变但语义相同 → 应被模糊命中
    const reworded: AuditFinding = { category: "inconsistency", docTitle: "会员协议、隐私政策", problem: "对数据保留期限的说法并不一致", suggestion: "对齐" };
    expect(findingHash(reworded)).not.toBe(findingHash(acked[0])); // 精确 hash 挡不住
    expect(isFuzzyAcked(reworded, refs)).toBe(true);                // 模糊能挡住
  });

  it("同文档同类别但不同问题 → 不误杀(仍上报)", () => {
    const acked: AuditFinding[] = [
      { category: "inconsistency", docTitle: "会员协议、隐私政策", problem: "关于数据保留期限的表述不一致", suggestion: "统一" },
    ];
    const refs = buildFuzzyRefs(acked);
    const newIssue: AuditFinding = { category: "inconsistency", docTitle: "会员协议、隐私政策", problem: "第三方 SDK 清单缺失且未列明用途", suggestion: "补充" };
    expect(isFuzzyAcked(newIssue, refs)).toBe(false);
  });

  it("不同类别即使文本相似也不命中(按类别隔离)", () => {
    const acked: AuditFinding[] = [
      { category: "logic", docTitle: "报销流程", problem: "步骤 3 与步骤 4 顺序矛盾", suggestion: "调整" },
    ];
    const refs = buildFuzzyRefs(acked);
    const other: AuditFinding = { category: "optimize", docTitle: "报销流程", problem: "步骤 3 与步骤 4 顺序矛盾", suggestion: "调整" };
    expect(isFuzzyAcked(other, refs)).toBe(false);
  });

  it("长/共享 docTitle + 不同问题 → 不误杀(problem 单独算,docTitle 不主导)", () => {
    // 回归:旧实现把 docTitle+problem 拼一起算,长 docTitle 会让同文档两个不同问题冲过阈值。
    const acked: AuditFinding[] = [
      { category: "inconsistency", docTitle: "会员服务协议、隐私政策、儿童个人信息保护规则、第三方SDK目录", problem: "生效日期不一致", suggestion: "对齐" },
    ];
    const refs = buildFuzzyRefs(acked);
    const newIssue: AuditFinding = { category: "inconsistency", docTitle: "会员服务协议、隐私政策、儿童个人信息保护规则、第三方SDK目录", problem: "管辖法院约定不一致", suggestion: "对齐" };
    expect(isFuzzyAcked(newIssue, refs)).toBe(false); // 不同问题,即便同一长文档也不误杀
  });

  it("文档顺序颠倒 + 同问题 → 仍命中(docTitle 顺序无关)", () => {
    const acked: AuditFinding[] = [
      { category: "inconsistency", docTitle: "会员协议、隐私政策", problem: "关于数据保留期限的表述不一致", suggestion: "统一" },
    ];
    const refs = buildFuzzyRefs(acked);
    const reordered: AuditFinding = { category: "inconsistency", docTitle: "隐私政策、会员协议", problem: "关于数据保留期限的表述不一致", suggestion: "统一" };
    expect(isFuzzyAcked(reordered, refs)).toBe(true);
  });

  it("同措辞 problem 但不同文档 → 不命中(docTitle 门槛)", () => {
    const acked: AuditFinding[] = [
      { category: "inconsistency", docTitle: "会员协议、隐私政策", problem: "关于数据保留期限的表述不一致", suggestion: "统一" },
    ];
    const refs = buildFuzzyRefs(acked);
    const otherDoc: AuditFinding = { category: "inconsistency", docTitle: "采购制度、合同模板", problem: "关于数据保留期限的表述不一致", suggestion: "统一" };
    expect(isFuzzyAcked(otherDoc, refs)).toBe(false);
  });
});

describe("renderFindings", () => {
  it("空 → 未发现明显问题", () => {
    expect(renderFindings([])).toContain("未发现明显问题");
  });
  it("三段式;有项的渲染《文档》+问题+建议,无项写未发现", () => {
    const hashed = dedupeFindings([
      { category: "inconsistency", docTitle: "入职指南、考勤制度", problem: "试用期说法不一致", suggestion: "统一" },
      { category: "optimize", docTitle: "报销流程", problem: "步骤过时", suggestion: "更新" },
    ]);
    const md = renderFindings(hashed);
    expect(md).toContain("## 文档间不一致");
    expect(md).toContain("《入职指南、考勤制度》试用期说法不一致");
    expect(md).toContain("## 文档内逻辑错误\n未发现");
    expect(md).toContain("## 可优化点");
    expect(md).toContain("《报销流程》步骤过时");
  });
});
