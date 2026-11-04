import { describe, it, expect } from "vitest";
import { buildDocAuditCard } from "./audit.js";
import { dedupeFindings } from "./findings.js";

const GEN_AT = new Date("2026-06-10T01:00:00Z"); // 北京 09:00

interface Checker {
  tag: string;
  checked?: boolean;
  name?: string;
  checked_style?: { show_strikethrough?: boolean; opacity?: number };
  behaviors?: Array<{ type?: string; value?: { k?: string; h?: string } }>;
  text?: { content?: string };
}
type Card2 = {
  schema: string;
  config: { update_multi?: boolean; width_mode?: string };
  header: { title: { content: string } };
  body: { elements: Array<Checker & { content?: string }> };
};
const card2 = (card: unknown) => card as Card2;
const checkers = (card: unknown): Checker[] => card2(card).body.elements.filter((e) => e.tag === "checker");
const bodyText = (card: unknown) =>
  card2(card).body.elements.map((e) => e.content ?? e.text?.content ?? "").join("\n");
const hOf = (c: Checker) => c.behaviors?.[0]?.value?.h;

describe("doc-audit 勾选器卡片(2.0)", () => {
  const findings = dedupeFindings([
    { category: "logic", docTitle: "报销流程", problem: "步骤矛盾", suggestion: "改" },
    { category: "optimize", docTitle: "入职指南", problem: "已过时", suggestion: "更新" },
  ]);

  it("是 2.0 卡片:schema/config/标题/文档数/时间", () => {
    const card = card2(buildDocAuditCard({ findings, acknowledgedHashes: new Set(), docCount: 5, truncated: 0, generatedAt: GEN_AT, llmFailed: false }));
    expect(card.schema).toBe("2.0");
    expect(card.config.update_multi).toBe(true);
    expect(card.config.width_mode).toBe("fill");
    expect(card.header.title.content).toContain("文档体检");
    const text = bodyText(card);
    expect(text).toContain("检查文档");
    expect(text).toContain("5 篇");
    expect(text).toContain("2026-06-10 09:00");
  });

  it("每条 finding 是 checker(callback value.k/h + 删除线样式),未确认时都没勾", () => {
    const card = buildDocAuditCard({ findings, acknowledgedHashes: new Set(), docCount: 5, truncated: 0, generatedAt: GEN_AT, llmFailed: false });
    const cs = checkers(card);
    expect(cs).toHaveLength(2);
    for (const c of cs) {
      expect(c.checked_style?.show_strikethrough).toBe(true);
      expect(c.behaviors?.[0]?.type).toBe("callback");
      expect(c.behaviors?.[0]?.value?.k).toBe("doc_audit_ack");
      expect(c.checked).toBe(false);
    }
    expect(cs.map(hOf).sort()).toEqual(findings.map((f) => f.hash).sort());
  });

  it("已确认的条目 checked=true,其余 false", () => {
    const card = buildDocAuditCard({ findings, acknowledgedHashes: new Set([findings[0].hash]), docCount: 5, truncated: 0, generatedAt: GEN_AT, llmFailed: false });
    const cs = checkers(card);
    expect(cs.find((c) => hOf(c) === findings[0].hash)?.checked).toBe(true);
    expect(cs.find((c) => hOf(c) === findings[1].hash)?.checked).toBe(false);
  });

  it("超过 50 条退化为纯文本 + 提示", () => {
    const many = dedupeFindings(
      Array.from({ length: 60 }, (_, i) => ({ category: "logic" as const, docTitle: `D${i}`, problem: `P${i}`, suggestion: "" })),
    );
    const card = buildDocAuditCard({ findings: many, acknowledgedHashes: new Set(), docCount: 60, truncated: 0, generatedAt: GEN_AT, llmFailed: false });
    expect(checkers(card)).toHaveLength(50);
    expect(bodyText(card)).toContain("另有 10 条");
  });

  it("无文档 / 生成失败 / 无问题 兜底文案", () => {
    expect(bodyText(buildDocAuditCard({ findings: [], acknowledgedHashes: new Set(), docCount: 0, truncated: 0, generatedAt: GEN_AT, llmFailed: false }))).toContain("暂无已发布文档");
    expect(bodyText(buildDocAuditCard({ findings: [], acknowledgedHashes: new Set(), docCount: 5, truncated: 0, generatedAt: GEN_AT, llmFailed: true }))).toContain("未生成结果");
    expect(bodyText(buildDocAuditCard({ findings: [], acknowledgedHashes: new Set(), docCount: 5, truncated: 0, generatedAt: GEN_AT, llmFailed: false }))).toContain("未发现明显问题");
  });
});
