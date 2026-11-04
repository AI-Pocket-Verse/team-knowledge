// 单篇 AI 校验的「结构化问题条目」纯函数:LLM 产 JSON → 解析 → 去重 → 每条带稳定
// hash(身份),供「按问题忽略 / 永久抑制」复用 doc-audit 的 hash 套路(此处按文章隔离)。
import { createHash } from "node:crypto";

export type ReviewCategory = "logic" | "clarity" | "format" | "completeness" | "consistency";
export const REVIEW_CATEGORIES: ReviewCategory[] = ["logic", "clarity", "format", "completeness", "consistency"];
export const REVIEW_CATEGORY_LABEL_EN: Record<ReviewCategory, string> = {
  logic: "Contradiction",
  clarity: "Unclear wording",
  format: "Formatting",
  completeness: "Missing / outdated info",
  consistency: "Cross-doc mismatch",
};
export const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  logic: "逻辑矛盾",
  clarity: "表述不清",
  format: "格式问题",
  completeness: "信息缺失/过时",
  consistency: "跨文档出入",
};

export type ReviewSeverity = "high" | "med" | "low";
const SEVERITIES: ReviewSeverity[] = ["high", "med", "low"];

// 严重度排序(数值越大越严重),用于「严重度阈值」过滤:低于阈值的问题不点亮徽标。
const SEVERITY_RANK: Record<ReviewSeverity, number> = { low: 0, med: 1, high: 2 };
export function severityRank(s: ReviewSeverity): number {
  return SEVERITY_RANK[s] ?? SEVERITY_RANK.med;
}
/** 丢弃严重度低于 min 的问题(min 非法时回退 "low" = 不过滤)。纯函数,便于测。 */
export function filterBySeverity<T extends Pick<ReviewFinding, "severity">>(
  findings: T[],
  min: ReviewSeverity,
): T[] {
  const floor = severityRank(SEVERITIES.includes(min) ? min : "low");
  return findings.filter((f) => severityRank(f.severity) >= floor);
}

export interface ReviewFinding {
  category: ReviewCategory;
  severity: ReviewSeverity;
  problem: string;
  suggestion: string;
}
export interface HashedReviewFinding extends ReviewFinding {
  hash: string;
}

const FIELD_CAP = 400;
function clampStr(v: unknown, max = FIELD_CAP): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 稳定指纹:类别 + 归一化问题(空白折叠)。severity/suggestion 不进 hash —— 同一问题
 *  换措辞或改严重度仍算同一条,忽略后不会因模型微调描述而复活。 */
export function reviewFindingHash(f: Pick<ReviewFinding, "category" | "problem">): string {
  const norm = `${f.category}|${f.problem.replace(/\s+/g, " ").trim()}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

/** 从 LLM 文本稳健抽取 {findings:[...]}:剥代码块、取最外层 {…}、容错。失败 → []。 */
export function parseReviewFindings(text: string): ReviewFinding[] {
  if (!text) return [];
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const i = stripped.indexOf("{");
  const j = stripped.lastIndexOf("}");
  if (i < 0 || j < i) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(stripped.slice(i, j + 1));
  } catch {
    return [];
  }
  const arr = (obj as { findings?: unknown }).findings;
  if (!Array.isArray(arr)) return [];
  const out: ReviewFinding[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const category = REVIEW_CATEGORIES.includes(r.category as ReviewCategory) ? (r.category as ReviewCategory) : null;
    const problem = clampStr(r.problem);
    if (!category || !problem) continue;
    const severity = SEVERITIES.includes(r.severity as ReviewSeverity) ? (r.severity as ReviewSeverity) : "med";
    out.push({ category, severity, problem, suggestion: clampStr(r.suggestion) });
  }
  return out;
}

/** 按 hash 去重并附 hash。 */
export function hashReviewFindings(findings: ReviewFinding[]): HashedReviewFinding[] {
  const seen = new Set<string>();
  const out: HashedReviewFinding[] = [];
  for (const f of findings) {
    const hash = reviewFindingHash(f);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ ...f, hash });
  }
  return out;
}
