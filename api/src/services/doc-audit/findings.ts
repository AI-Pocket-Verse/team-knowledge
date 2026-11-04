// 文档体检的「结构化问题条目」纯函数:LLM 产 JSON → 解析 → 去重 → 渲染。
// 用于跨批去重 + 卡片正文;每条带稳定 hash,为后续的「勾选确认 / 下次
// 不再提醒」铺路(hash 作为条目身份)。
import { createHash } from "node:crypto";

export type AuditCategory = "inconsistency" | "logic" | "optimize";
export const AUDIT_CATEGORIES: AuditCategory[] = ["inconsistency", "logic", "optimize"];
export const CATEGORY_LABEL: Record<AuditCategory, string> = {
  inconsistency: "文档间不一致",
  logic: "文档内逻辑错误",
  optimize: "可优化点",
};

export interface AuditFinding {
  category: AuditCategory;
  docTitle: string; // 涉及文档标题(多篇用、连接);可空
  problem: string;
  suggestion: string;
}
export interface HashedFinding extends AuditFinding {
  hash: string;
}

const FIELD_CAP = 400;

function clampStr(v: unknown, max = FIELD_CAP): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 稳定指纹:类别 + 文档 + 归一化问题(空白折叠)。供跨批精确去重 / 后续记忆。 */
export function findingHash(f: AuditFinding): string {
  const norm = `${f.category}|${f.docTitle.replace(/\s+/g, " ").trim()}|${f.problem.replace(/\s+/g, " ").trim()}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

// ── 抗改写的模糊指纹(用于「已确认下次不再提醒」的硬过滤兜底)────────────────
// 精确 hash 只能挡「一字不差」的复报;LLM 换个说法描述同一问题时 hash 就变了。这里用
// 字符 bigram(中文友好、无需分词)+ Jaccard 相似度做模糊匹配。命中需三者都满足:
//   ① 同类别;② problem 文本相似度 ≥ FUZZY_THRESHOLD;③ 同一文档(docTitle 匹配)。
// 关键:相似度只算 **problem**,不把 docTitle 拼进去——否则长/反复出现的 docTitle(跨文档
// 不一致类最常见)会主导相似度,让同文档的两个【不同问题】也冲过阈值,误杀真正的新问题。
// docTitle 单独作「是否同一文档」的门槛,顺序无关。
// 阈值依实测标定(problem-only Jaccard):同文档「不同问题」约 0.0~0.20,「轻度改写」约 0.44,
// 取 0.4 挡轻改写(留 2× 余量不误杀);「中/重度改写」会跌到 ~0.2、与噪声难分,词面法无力,
// 交由软层 prompt 语义兜底。「仅顺序/数字相反」这类 bigram 难分的极窄情形可能被当作同条——
// 但那多是同一处的复报,可接受。
export const FUZZY_THRESHOLD = 0.4;  // problem Jaccard(0~1);≥ 此值 + 同文档同类别 → 视为同一条
const FUZZY_MIN_BIGRAMS = 5;         // problem 太短 → bigram 不稳,交回精确 hash
const DOCTITLE_SIM = 0.5;            // docTitle 相似度门槛(顺序无关;挡「同措辞不同文档」)

function normForFuzzy(s: string): string {
  // 去空白 + 常见中英文标点,转小写:让「和/与」「,/、」「。」这类差异不影响指纹。
  return s.replace(/\s+/g, "").replace(/[，。、；;：:！!？?「」『』（）()《》【】\-—…·.,"'“”‘’]/g, "").toLowerCase();
}

/** 字符 bigram 集合(归一化后相邻两字)。中文友好,无需分词。 */
export function bigrams(s: string): Set<string> {
  const t = normForFuzzy(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 两个集合的 Jaccard 相似度(交/并);任一为空 → 0。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 两个 docTitle 是否指同一(组)文档:都空→是;一空一有→否;归一化后相等→是;
 *  否则按 bigram Jaccard ≥ DOCTITLE_SIM(顺序无关,容忍「A、B」↔「B、A」及个别用字差异)。 */
export function docTitleMatches(a: string, b: string): boolean {
  const na = normForFuzzy(a), nb = normForFuzzy(b);
  if (na === "" && nb === "") return true;
  if (na === "" || nb === "") return false;
  if (na === nb) return true;
  return jaccard(bigrams(a), bigrams(b)) >= DOCTITLE_SIM;
}

export interface FuzzyRef { category: string; docTitle: string; problemGrams: Set<string>; }

/** 预计算已确认条目的模糊指纹(problem 侧 bigram 预算好;docTitle 保留原文按需比对)。 */
export function buildFuzzyRefs(acked: AuditFinding[]): FuzzyRef[] {
  return acked.map((f) => ({ category: f.category, docTitle: f.docTitle, problemGrams: bigrams(f.problem) }));
}

/** 新条目是否与任一已确认条「同类别 + problem 相似 ≥ 阈值 + 同文档」→ 视为已确认(抗改写)。
 *  problem 太短(bigram 不足)→ 返回 false,交给精确 hash,避免短串/纯 docTitle 误判。 */
export function isFuzzyAcked(f: AuditFinding, refs: FuzzyRef[], threshold = FUZZY_THRESHOLD): boolean {
  const g = bigrams(f.problem);
  if (g.size < FUZZY_MIN_BIGRAMS) return false;
  for (const r of refs) {
    if (r.category !== f.category || r.problemGrams.size < FUZZY_MIN_BIGRAMS) continue;
    if (jaccard(g, r.problemGrams) < threshold) continue;
    if (!docTitleMatches(f.docTitle, r.docTitle)) continue;
    return true;
  }
  return false;
}

/** 从 LLM 文本里稳健抽取 {findings:[...]}:剥 ``` 代码块、取最外层 {…}、容错解析。
 *  解析失败 / 结构不符 / 字段不合法 → 跳过该条或返回空数组(上层据此走兜底文案)。 */
export function parseFindings(text: string): AuditFinding[] {
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
  const out: AuditFinding[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const category = AUDIT_CATEGORIES.includes(r.category as AuditCategory) ? (r.category as AuditCategory) : null;
    const problem = clampStr(r.problem);
    if (!category || !problem) continue; // 缺类别或缺问题正文的丢弃
    out.push({ category, docTitle: clampStr(r.docTitle, 200), problem, suggestion: clampStr(r.suggestion) });
  }
  return out;
}

/** 按 hash 跨批精确去重,附带 hash。 */
export function dedupeFindings(findings: AuditFinding[]): HashedFinding[] {
  const seen = new Set<string>();
  const out: HashedFinding[] = [];
  for (const f of findings) {
    const hash = findingHash(f);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ ...f, hash });
  }
  return out;
}

/** findings → 三段式 Markdown(卡片正文 + 日志/脚本 back-compat 用)。 */
export function renderFindings(findings: HashedFinding[]): string {
  if (findings.length === 0) return "本次体检未发现明显问题。";
  const lines: string[] = [];
  for (const cat of AUDIT_CATEGORIES) {
    lines.push(`## ${CATEGORY_LABEL[cat]}`);
    const items = findings.filter((f) => f.category === cat);
    if (items.length === 0) {
      lines.push("未发现");
    } else {
      items.forEach((f, idx) => {
        const doc = f.docTitle ? `《${f.docTitle}》` : "";
        const sug = f.suggestion ? `（建议:${f.suggestion}）` : "";
        lines.push(`${idx + 1}. ${doc}${f.problem}${sug}`);
      });
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
