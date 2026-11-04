// 专家地基:跨角色「请教」。文档全员共享、谁都能读,所以请教不是为读文档,而是拿目标
// 角色专家的【专长视角/skill】。带硬护栏防失控:深度 ≤ 2、单次对话总请教 ≤ 3、防环、目标须允许被请教。
import { getExpert } from "./config.js";
import { answerAsExpert, type RunExpertLlm, type RetrievalCache } from "./expert.js";

export const MAX_CONSULT_DEPTH = 2;
export const MAX_CONSULT_COUNT = 3;

// 一次用户对话内共享:已请教次数 + 已在链上的角色(防环)。depth 由调用方在向更深请教时 +1 传入。
export interface ConsultContext { depth: number; count: number; chain: Set<string>; }
export function newConsultContext(): ConsultContext { return { depth: 0, count: 0, chain: new Set() }; }

export type ConsultReason = "depth" | "count" | "cycle" | "not-allowed" | "unavailable";
export interface ConsultResult { ok: boolean; answer?: string; reason?: ConsultReason; }

/** 向目标角色专家请教一个有界子问题。成功时累加 ctx(count++、chain 加入目标)。失败给出 reason。 */
export async function consult(
  targetRoleId: string,
  subQuestion: string,
  ctx: ConsultContext,
  opts: { runLlm?: RunExpertLlm; cache?: RetrievalCache; summary?: string } = {},
): Promise<ConsultResult> {
  if (ctx.depth >= MAX_CONSULT_DEPTH) return { ok: false, reason: "depth" };
  if (ctx.count >= MAX_CONSULT_COUNT) return { ok: false, reason: "count" };
  if (ctx.chain.has(targetRoleId)) return { ok: false, reason: "cycle" };

  const cfg = await getExpert(targetRoleId);
  if (!cfg.enabled || !cfg.sources.consult) return { ok: false, reason: "not-allowed" };

  const ans = await answerAsExpert(targetRoleId, subQuestion, { subQuestion: true, runLlm: opts.runLlm, cache: opts.cache, summary: opts.summary });
  if (ans === null) return { ok: false, reason: "unavailable" };

  ctx.count += 1;
  ctx.chain.add(targetRoleId);
  return { ok: true, answer: ans.answer };
}
