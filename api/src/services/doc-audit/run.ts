// 知识库「文档体检」跑数层:拉全部已发布文档 → 按预算分批(每篇整篇读)→ 每批交
// 给内置 LLM 产「结构化问题条目(JSON)」→ 跨批去重 + (多批时)LLM 合并 → 组飞书
// 卡片。工作日早 9 点定时跑(进程内调度,也供「通知测试」手动触发)。
//
// 为什么分批:早先把全部文档拼成一坨(MAX_INPUT_CHARS=12 万字)单次喂模型,超预算
// 的文档只留开头(truncated),知识库一大就有一堆「仅检查了开头」。分批后每篇都在所
// 在批被完整阅读;跨批的「文档间不一致」是近似(靠合并阶段在批结果里发现)。
import { prisma } from "../../db.js";
import { hasRetrievableContent } from "../../utils/retrievable.js";
import { getAssistantExclusionSets, exclusionPrismaWhere } from "../assistant-filter/exclusions.js";
import { packArticles, batchArticles } from "../role-skill/source.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import { buildDocAuditCard } from "./audit.js";
import {
  parseFindings, dedupeFindings, renderFindings, buildFuzzyRefs, isFuzzyAcked,
  type AuditFinding, type HashedFinding,
} from "./findings.js";
import { getAcknowledgedHashes, getAcknowledgedForPrompt, getAcknowledgedFindings, setLastCard } from "./acks.js";
import { getDocAuditTuning } from "./config.js";
import { appLang } from "../../utils/lang.js";
import { outputLanguageInstruction } from "../llm/language.js";

const BATCH_SYSTEM = `你是团队知识库的质检助手。下面是知识库里【一部分已发布文档】(每篇以「## 标题」开头)。通读后找出三类问题:
- inconsistency 文档间不一致:不同文档对同一事项说法矛盾 / 数据对不上;
- logic 文档内逻辑错误:单篇内部自相矛盾、步骤错乱、明显事实硬伤;
- optimize 可优化点:过时、重复冗余、表述不清、缺关键信息。
只报真正有价值的问题,没有就不报。严格【只输出 JSON】,不要任何解释文字、不要 markdown 代码块,结构:
{"findings":[{"category":"inconsistency|logic|optimize","docTitle":"涉及文档标题(多篇用、连接)","problem":"具体问题","suggestion":"改进建议"}]}
没有任何问题就输出 {"findings":[]}。每条简明扼要,problem / suggestion 各 ≤ 60 字。`;

const MERGE_SYSTEM = `以下是知识库文档体检【分批】得到的问题清单(JSON)。请合并成最终清单:
- 去掉重复或语义相同的条目;同一文档的同类问题合并成一条;
- 按重要性从高到低排序;最多保留 30 条。
严格【只输出】同样结构的 JSON({"findings":[{"category":...,"docTitle":...,"problem":...,"suggestion":...}]}),不要任何额外文字、不要代码块。`;

// 把「已确认」条目注入 system,让模型语义跳过(改写措辞也压得住)。
function withSuppression(system: string, acked: { docTitle: string; problem: string }[]): string {
  if (acked.length === 0) return system;
  const list = acked.map((a) => `- 《${a.docTitle}》${a.problem}`).join("\n");
  return `${system}\n\n【以下问题用户已确认,请不要再报告这些或语义相同的问题】:\n${list}`;
}

// 把「检测强度」注入 system,让模型据此调整检出的严格程度与条目数量。纯函数,便于测。
export function withStrength(system: string, strength: number): string {
  return `${system}\n\n【检测强度 ${strength}/10】1=只报最严重、最明显的问题(高精确、宁缺毋滥);10=尽可能全面严格,连细微/潜在/风格问题也一并指出(高召回、可能更多条)。请据此调整检出的严格程度与条目数量。`;
}

// 每种类别最多保留 n 条(保持原有顺序)。纯函数,便于测。
export function capPerCategory<T extends { category: string }>(findings: T[], n: number): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const f of findings) {
    const c = counts.get(f.category) ?? 0;
    if (c >= n) continue;
    counts.set(f.category, c + 1);
    out.push(f);
  }
  return out;
}

const MAX_AUDIT_TIMEOUT_MS = 180_000;
const MAX_FINDINGS = 40;

/** 跑一次内置 LLM(带全局并发闸 + 超时)。无内容 / 繁忙 / 失败 / 超时都返回 null。 */
async function callLlm(system: string, user: string): Promise<string | null> {
  if (!user.trim()) return null;
  let release: () => void;
  try {
    release = await chatSemaphore.acquire(30_000);
  } catch {
    console.warn("[doc-audit] LLM 繁忙,本次降级省略");
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MAX_AUDIT_TIMEOUT_MS);
  try {
    const provider = await getProvider();
    let text = "";
    for await (const chunk of provider.chat({ systemPrompt: system, history: [], userMessage: user }, ac.signal)) {
      if (chunk.type === "token") text += chunk.text;
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
    return text.trim() || null;
  } catch (e) {
    console.warn("[doc-audit] LLM 调用失败:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}

export interface DocAuditResult {
  card: unknown;
  /** 渲染后的三段式文本(日志 / 脚本 back-compat);全部批次都失败时为 null。 */
  report: string | null;
  /** 结构化条目(每条带 hash;后续勾选确认 / 抑制用)。 */
  findings: HashedFinding[];
  docCount: number;
  batchCount: number;
  truncated: number;
}

/** 取参与体检的文档:全部有可检索正文(未删)的文档,再扣掉助手内容过滤里被排除
 *  的角色 / 文件夹(含子文件夹)/ 文档。空排除清单时退化为原行为(零回归)。抽成
 *  导出函数便于单测,排序 / select 字段与原内联查询保持一致。 */
export async function selectAuditableArticles() {
  const exclusion = exclusionPrismaWhere(await getAssistantExclusionSets());
  const rows = await prisma.article.findMany({
    where: { deletedAt: null, ...exclusion },
    orderBy: { updatedAt: "desc" },
    select: { title: true, contentMarkdown: true },
  });
  // 去状态后:按正文长度纳入(空/过短文档不进体检)。
  return rows.filter((a) => hasRetrievableContent(a.contentMarkdown));
}

/** 跑完整条体检链路(persist=false 时不记录 last_card,供测试卡用):全部已发布文档 → 分批 → 逐批 LLM(结构化)→ 去重 → 合并 →
 *  飞书卡片。定时脚本与「通知测试」共用,确保两边发出的卡片一致。 */
export async function runDocAudit(now: Date, opts: { persist?: boolean } = {}): Promise<DocAuditResult> {
  const articles = await selectAuditableArticles();
  if (articles.length === 0) {
    return {
      card: buildDocAuditCard({ findings: [], acknowledgedHashes: new Set(), docCount: 0, truncated: 0, generatedAt: now, llmFailed: false }),
      report: null, findings: [], docCount: 0, batchCount: 0, truncated: 0,
    };
  }

  const { strength, maxPerCategory } = await getDocAuditTuning();
  const batches = batchArticles(articles.map((a) => ({ title: a.title, contentMarkdown: a.contentMarkdown })));
  const ackedHashes = await getAcknowledgedHashes();
  const ackedForPrompt = await getAcknowledgedForPrompt(60);
  const fuzzyRefs = buildFuzzyRefs(await getAcknowledgedFindings()); // 抗改写模糊过滤参照(全部已确认)
  // 强度注入只包 BATCH_SYSTEM(检出阶段);抑制两个都包(检出 + 合并都要跳过已确认)。
  const batchSystem = withStrength(withSuppression(BATCH_SYSTEM, ackedForPrompt), strength) + outputLanguageInstruction(appLang());
  const mergeSystem = withSuppression(MERGE_SYSTEM, ackedForPrompt) + outputLanguageInstruction(appLang());
  let truncated = 0;
  let anyOk = false;
  const collected: AuditFinding[] = [];
  // 批次串行跑:避免并发多批挤爆全局 LLM 闸(取锁 30s 超时下,靠后的批会被丢)。
  for (const batch of batches) {
    const packed = packArticles(batch);
    truncated += packed.truncated;
    const text = await callLlm(batchSystem, packed.body);
    if (text !== null) {
      anyOk = true;
      collected.push(...parseFindings(text));
    }
  }

  let findings = dedupeFindings(collected);
  // 多批:再走一次 LLM 合并(语义去重 + 同文档合并 + 重要性排序)。解析失败则保留
  // 代码级去重结果(不让合并这步把已有结果清空)。
  if (batches.length > 1 && findings.length > 1) {
    const mergedText = await callLlm(mergeSystem, JSON.stringify({ findings }));
    if (mergedText !== null) {
      const merged = dedupeFindings(parseFindings(mergedText));
      if (merged.length > 0) findings = merged;
    }
  }
  // 双保险:prompt 没压住的,再按 ① 精确 hash + ② 模糊指纹(抗改写)过滤掉已确认条。
  // ② 挡「同一问题被 LLM 换个措辞重报」——同类别下与任一已确认条相似度 ≥ 阈值即滤掉。
  findings = findings.filter((f) => !ackedHashes.has(f.hash) && !isFuzzyAcked(f, fuzzyRefs));
  // 每类上限截断(保持顺序),再套整体 MAX_FINDINGS 上限,保证两者都生效。
  findings = capPerCategory(findings, maxPerCategory).slice(0, MAX_FINDINGS);

  // 连同 meta 一起存:点击勾选重建卡时保留原始「检查文档:N 篇 / 检查时间」,
  // 不被 findings 数 / 当前时刻覆盖(否则群里每次勾选都会广播一个错的篇数与时间)。
  // 只在真有结果(至少一批 LLM 成功)且是正式推送时才覆盖 last_card:全失败或「通知测试」
  // 发的测试卡写入的话,群里上一张真实体检卡的勾选回调会变成「该条目已不在最新报告中」。
  if (anyOk && opts.persist !== false) {
    await setLastCard(findings, { docCount: articles.length, generatedAt: now.toISOString(), truncated });
  }
  // anyOk=false(所有批次都失败)→ llmFailed → 卡片走「未生成结果」兜底;
  // anyOk 但 0 条 → 卡片出「未发现明显问题」。report(渲染文本)留给脚本/日志。
  const report = anyOk ? renderFindings(findings) : null;
  const card = buildDocAuditCard({ findings, acknowledgedHashes: new Set(), docCount: articles.length, truncated, generatedAt: now, llmFailed: !anyOk });
  return { card, report, findings, docCount: articles.length, batchCount: batches.length, truncated };
}
