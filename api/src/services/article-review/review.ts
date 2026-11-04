// 单篇 AI 校验核心。流程:取文档 → FTS 拉同角色相关文档摘要(跨文档一致性上下文)→
// LLM 产结构化 findings → 过滤忽略集 → 写库(走 $executeRaw,绝不 bump updatedAt)→
// 有问题则通知最后编辑者,无问题则清通知。LLM 调用可注入(runLlm)便于测试。
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../db.js";
import { hasRetrievableContent } from "../../utils/retrievable.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import { search } from "../retrieval/fts5.js";
import { parseReviewFindings, hashReviewFindings, filterBySeverity, type HashedReviewFinding } from "./findings.js";
import { lintHeadingFormat } from "./formatLint.js";
import { appLang, type Lang } from "../../utils/lang.js";
import { reviewSystem, buildReviewUserMessage } from "./prompt.js";
import { getDismissedHashes } from "./dismiss.js";
import { getMinSeverity } from "./config.js";
import { resolveLastEditorId, emitReviewNotification, clearReviewNotifications } from "./notify.js";

const RELATED_LIMIT = 6;
const MAX_REVIEW_TIMEOUT_MS = 180_000;

export interface RelatedDoc { title: string; snippet: string; }

/** 跨文档上下文:同角色相关文档摘要(排除本篇)。复检与一键优化共用,保证两者「看到的
 *  相关文档」一致 —— 否则优化盲改 consistency 类问题,复检再对比相关文档又报。检索失败返回 []。 */
export async function fetchRelatedDocs(article: { id: string; title: string; roleId: string }): Promise<RelatedDoc[]> {
  try {
    const hits = await search({ query: article.title, userId: "system", isAdmin: true, limit: RELATED_LIMIT + 1 });
    return hits
      .filter((h) => h.articleId !== article.id && h.roleId === article.roleId)
      .slice(0, RELATED_LIMIT)
      .map((h) => ({ title: h.title, snippet: h.body }));
  } catch {
    return []; // 检索失败不阻断
  }
}

/** 一次 LLM 调用的失败/成功原因。null 返回原本把 5 种情况折叠成一句「暂不可用」,
 *  难以定位;现回写具体 reason,供调用方据此定制用户提示与日志。 */
export type ReviewLlmReason =
  | "ok" | "empty_input" | "pre_aborted" | "semaphore_busy"
  | "empty_output" | "timeout" | "client_abort" | "provider_error";

/** 诊断注入:传入 log 则输出结构化日志(不传则静默,如 reviewArticle 的两遍复检);
 *  callReviewLlm 会把本次 reason 回写到同一对象,供调用方读取。 */
export interface ReviewLlmDiag {
  log?: Pick<FastifyBaseLogger, "info" | "warn">;
  label?: string;
  reason?: ReviewLlmReason;
}

export type RunReviewLlm = (
  system: string, user: string, signal?: AbortSignal,
  onToken?: (t: string) => void, diag?: ReviewLlmDiag,
) => Promise<string | null>;

/** 内容指纹:标题 + 正文(用于判定「自上次 review 后是否变化」)。用 NUL 分隔避免
 *  标题/正文边界处的歧义(("a","b") 不应与 ("a b","") 同 hash);取 24 位降低截断碰撞。 */
export function contentHash(title: string, body: string): string {
  return createHash("sha256").update(title).update("\0").update(body).digest("hex").slice(0, 24);
}

/** 真实 LLM 调用(带全局并发闸 + 超时)。无内容/繁忙/失败/超时 → null。镜像 doc-audit。
 *  传入 diag.log 时输出结构化日志(开始/完成/各类失败),并把 reason 回写 diag。 */
export const callReviewLlm: RunReviewLlm = async (system, user, signal, onToken, diag) => {
  const log = diag?.log;
  const label = diag?.label ?? "review";
  const t0 = Date.now();
  const setReason = (r: ReviewLlmReason) => { if (diag) diag.reason = r; };
  if (!user.trim()) { setReason("empty_input"); log?.warn({ label, reason: "empty_input" }, "[review-llm] 空输入,跳过"); return null; }
  if (signal?.aborted) { setReason("pre_aborted"); log?.warn({ label, reason: "pre_aborted" }, "[review-llm] 调用前已被取消"); return null; }
  let release: () => void;
  try {
    // 并发闸:满载时等 30s 仍抢不到槽 → LLM 全局繁忙。
    release = await chatSemaphore.acquire(30_000);
  } catch {
    setReason("semaphore_busy");
    log?.warn({ label, reason: "semaphore_busy", waitedMs: Date.now() - t0 }, "[review-llm] LLM 繁忙(并发闸 30s 超时),本次跳过");
    console.warn("[article-review] LLM 繁忙,本次跳过");
    return null;
  }
  const acquiredMs = Date.now() - t0;
  const ac = new AbortController();
  let timedOut = false;
  // 外部信号(如「一键优化」请求的客户端断连)→ 立刻中断本次 LLM,尽快释放并发槽与上层的 in-flight 锁。
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, MAX_REVIEW_TIMEOUT_MS);
  let providerName: string | undefined;
  let tokens = 0;
  let ttftMs = -1; // 首 token 延迟:非流式 provider(codex)会一直是 -1 直到最后一次性吐出
  try {
    const provider = await getProvider();
    providerName = provider.name;
    log?.info({ label, provider: providerName, promptChars: system.length + user.length, acquiredMs, timeoutMs: MAX_REVIEW_TIMEOUT_MS }, "[review-llm] 开始调用");
    let text = "";
    for await (const chunk of provider.chat({ systemPrompt: system, history: [], userMessage: user }, ac.signal)) {
      if (chunk.type === "token") {
        if (tokens === 0) ttftMs = Date.now() - t0;
        tokens++;
        text += chunk.text;
        onToken?.(chunk.text);
      } else if (chunk.type === "error") throw new Error(chunk.message);
    }
    const out = text.trim();
    if (!out) {
      setReason("empty_output");
      log?.warn({ label, provider: providerName, reason: "empty_output", elapsedMs: Date.now() - t0, tokens }, "[review-llm] provider 返回空内容");
      return null;
    }
    setReason("ok");
    log?.info({ label, provider: providerName, reason: "ok", elapsedMs: Date.now() - t0, ttftMs, tokens, chars: out.length }, "[review-llm] 完成");
    return out;
  } catch (e) {
    // 区分三种中断/失败:180s 超时 / 客户端断连 / provider 自身错误(子进程/error 帧)。
    const reason: ReviewLlmReason = timedOut ? "timeout" : signal?.aborted ? "client_abort" : "provider_error";
    setReason(reason);
    log?.warn({ label, provider: providerName, reason, elapsedMs: Date.now() - t0, tokens, err: (e as Error).message }, "[review-llm] 调用失败");
    console.warn("[article-review] LLM 调用失败:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    release();
  }
};

export interface ReviewOutcome {
  status: "ok" | "issues";
  findings: HashedReviewFinding[];
  reviewedHash: string;
}

/** 校验一篇。返回 null = 跳过(不存在/空内容/LLM 失败,状态不变,留待下轮)。 */
export async function reviewArticle(
  articleId: string,
  opts: { notify?: boolean; runLlm?: RunReviewLlm; lang?: Lang } = {},
): Promise<ReviewOutcome | null> {
  const runLlm = opts.runLlm ?? callReviewLlm;
  const lang = opts.lang ?? appLang();
  const art = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, title: true, contentMarkdown: true, roleId: true, deletedAt: true, updatedAt: true },
  });
  if (!art || art.deletedAt != null) return null;

  // TOCTOU 防护:记下取内容时的 updatedAt。LLM 可能跑 ≤180s,期间用户可能保存了新版本;
  // persistReview 用它做条件写,内容已变就放弃本次(不落库、不通知),留待下轮按新内容复检。
  const expectedUpdatedAt = art.updatedAt;
  const hash = contentHash(art.title, art.contentMarkdown);

  // 空/过短文档:不调 LLM,标记已检(reviewedHash=当前)避免反复进候选。
  if (!hasRetrievableContent(art.contentMarkdown)) {
    await persistReview(articleId, "none", null, hash, expectedUpdatedAt);
    return null;
  }

  // 跨文档上下文:同角色相关文档摘要(排除本篇)。FTS 内部已应用内容过滤。
  const related = await fetchRelatedDocs(art);
  const userMsg = buildReviewUserMessage({ title: art.title, body: art.contentMarkdown }, related);

  // (D)两遍取交集压抖动:复检 LLM 无记忆且采样有方差,同一内容两次会报出不同小问题。
  // 跑两遍、只保留两遍 hash 都出现的问题,去掉一次性噪声。第一遍失败 → 整体跳过(留待下轮);
  // 第二遍失败 → 退化为只用第一遍结果(不因省成本而漏报,也不因抖动而阻塞)。
  const text1 = await runLlm(reviewSystem(lang), userMsg);
  if (text1 === null) return null; // LLM 失败:状态不变,下轮重试
  const pass1 = hashReviewFindings(parseReviewFindings(text1));
  const text2 = await runLlm(reviewSystem(lang), userMsg);
  let merged: HashedReviewFinding[];
  if (text2 === null) {
    merged = pass1; // 第二遍不可用 → 用第一遍
  } else {
    const pass2 = new Set(hashReviewFindings(parseReviewFindings(text2)).map((f) => f.hash));
    merged = pass1.filter((f) => pass2.has(f.hash)); // 交集:两遍都点名才算数
  }

  // 合并「确定性格式预检」(不依赖 LLM 是否点名):标题残留 ** 等格式符号 / 标题层级跳级,
  // 必报。按 hash 去重并入 LLM 结果(预检在前,确保稳定保留)。
  const byHash = new Map<string, HashedReviewFinding>();
  for (const f of [...hashReviewFindings(lintHeadingFormat(art.contentMarkdown, lang)), ...merged]) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, f);
  }
  merged = [...byHash.values()];

  // 过滤:忽略集 → 严重度阈值(默认丢 low,避免吹毛求疵把徽标永久点亮)。
  const dismissed = await getDismissedHashes(articleId);
  const minSeverity = await getMinSeverity();
  let findings = merged.filter((f) => !dismissed.has(f.hash));
  findings = filterBySeverity(findings, minSeverity);

  if (findings.length === 0) {
    const ok = await persistReview(articleId, "ok", null, hash, expectedUpdatedAt);
    if (!ok) return null; // 内容在校验期间被改动 → 放弃,留待下轮按新内容复检
    if (opts.notify) await clearReviewNotifications(articleId);
    return { status: "ok", findings: [], reviewedHash: hash };
  }

  const persisted = await persistReview(articleId, "issues", JSON.stringify(findings), hash, expectedUpdatedAt);
  if (!persisted) return null; // 同上:内容已变,不落库/不通知
  if (opts.notify) {
    const recipientId = await resolveLastEditorId(articleId);
    if (recipientId) {
      await emitReviewNotification({ articleId, articleTitle: art.title, recipientId, findings, reviewedHash: hash });
    }
  }
  return { status: "issues", findings, reviewedHash: hash };
}

// 写 review 状态:必须 $executeRaw —— prisma.update 会 bump @updatedAt,既自触发再扫描
// 又会让正在编辑者的下一次保存因 expectedUpdatedAt 不符而 409。
// 条件写:WHERE updatedAt = 取内容时的值(SQLite 存为 epoch-ms 整数,绑定 .getTime() 精确比较)。
// 若校验期间内容被改动(updatedAt 变),更新 0 行 → 返回 false,调用方放弃本次。
async function persistReview(
  articleId: string,
  status: string,
  findingsJson: string | null,
  hash: string,
  expectedUpdatedAt: Date,
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "Article"
       SET "reviewStatus" = ${status}, "reviewFindings" = ${findingsJson},
           "reviewedHash" = ${hash}, "reviewedAt" = ${Date.now()}
     WHERE "id" = ${articleId} AND "updatedAt" = ${expectedUpdatedAt.getTime()}
  `;
  return n > 0;
}
