// In-process scheduler for role-skill regeneration. Mirrors notify/dispatcher:
// a re-entrant-safe sweep picks roles whose skill has been stale (or failed)
// long enough and regenerates them, bounded per pass. Nudged on-demand by
// markRoleSkillStale (debounced via QUIET_MS) and on a poll interval.
import { prisma } from "../../db.js";
import { generateRoleSkill } from "./generate.js";
import { isRestoring } from "../backup.js";

// Debounce: only regenerate once a role has been quiet (no further changes)
// for this long, so a burst of edits coalesces into one generation. 2 min keeps
// edit-bursts coalesced while making "编辑后多久生成" feel responsive (worst case
// ≈ QUIET_MS + one sweep + generation ≈ 3–6 min).
export const QUIET_MS = 2 * 60 * 1000;

// 轻量日志(本服务无 fastify logger;沿用 skill-diff.ts 的 console 约定)。给 generate
// 传入,让「跳过/失败/成功」在 dev 日志与 prod stdout 都可见——此前 dispatcher 不传 log,
// generate 里的埋点全是 no-op,导致「skill 不生成」在生产完全无法诊断。
const genLog = { info: console.info, warn: console.warn, error: console.error };
export const MAX_ATTEMPTS = 3;
export const MAX_PER_SWEEP = 2;
const SWEEP_MS = 60_000;
// A 'generating' row older than this is considered orphaned (the process that
// claimed it crashed/restarted, or its provider call hung past its own timeout)
// and is reclaimed — otherwise it sticks forever (the sweep only selects
// stale/failed). Must exceed generate.ts's GEN_TIMEOUT_MS (180s) so a legitimately
// in-flight generation is never reclaimed out from under itself.
const GEN_STUCK_MS = 5 * 60 * 1000;

let running = false;
let rerunRequested = false;

/** Reclaim orphaned 'generating' rows (older than `olderThanMs`) back to stale so
 *  they're eligible again. Backdates staleSince so they're immediately due. */
async function reclaimGenerating(olderThanMs: number): Promise<void> {
  await prisma.roleSkill.updateMany({
    where: { status: "generating", updatedAt: { lt: new Date(Date.now() - olderThanMs) } },
    data: { status: "stale", staleSince: new Date(Date.now() - QUIET_MS - 1000) },
  });
}

/** One sweep. Re-entrant-safe. A kick that arrives mid-sweep (e.g. a manual
 *  regenerate while the periodic sweep is running) is coalesced into a single
 *  follow-up pass rather than dropped — so "立即重新生成" doesn't wait a full
 *  interval under contention. */
export async function kickRoleSkill(): Promise<void> {
  if (isRestoring()) return; // 还原热替换库期间不碰 DB
  if (running) { rerunRequested = true; return; }
  running = true;
  try {
    // Recover rows stuck 'generating' (hung provider past timeout) before selecting.
    await reclaimGenerating(GEN_STUCK_MS).catch(() => undefined);
    const cutoff = new Date(Date.now() - QUIET_MS);
    const due = await prisma.roleSkill.findMany({
      where: {
        status: { in: ["stale", "failed"] },
        staleSince: { lte: cutoff }, // nulls never match a date comparison
        attempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { staleSince: "asc" },
      take: MAX_PER_SWEEP,
      select: { roleId: true },
    });
    if (due.length > 0) console.info(`[role-skill] sweep: ${due.length} due → 生成`, { roleIds: due.map((r) => r.roleId) });
    // allSettled: generateRoleSkill already swallows its own errors, but a stray
    // rejection (e.g. an FK race on role deletion) must never reject the sweep or
    // surface as an unhandled rejection on the interval tick. The provider
    // semaphore inside serializes the actual model calls. 传入 genLog 让生成过程
    // (成功/失败/跳过空/无变化)在日志里可见。
    await Promise.allSettled(due.map((r) => generateRoleSkill(r.roleId, { log: genLog })));
  } finally {
    running = false;
  }
  if (rerunRequested) { rerunRequested = false; void kickRoleSkill(); }
}

export function startRoleSkillDispatcher(intervalMs = SWEEP_MS): ReturnType<typeof setInterval> {
  // On boot, ANY 'generating' row is an orphan from a previous process (only one
  // process generates at a time) — reset it regardless of age, then sweep once
  // so a skill interrupted by a restart regenerates promptly instead of being
  // stuck on "生成中" forever.
  void (async () => {
    await reclaimGenerating(-1).catch(() => undefined); // -1 → "older than the future" → matches all
    await kickRoleSkill().catch(() => undefined);
  })();
  return setInterval(() => { void kickRoleSkill(); }, intervalMs);
}
