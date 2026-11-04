import { prisma } from "../../db.js";
import { trackBestEffort } from "../../utils/guards.js";

/**
 * Mark a role's skill stale (best-effort). Call this from route handlers AFTER a
 * published doc — or the role itself — changes. Fire-and-forget: never blocks or
 * fails the request. DRAFT-only changes must NOT call this (the skill is built
 * from published docs only).
 *
 * It does NOT kick the dispatcher: regeneration is debounced (QUIET_MS) and the
 * periodic sweep picks the row up once the quiet window elapses. Keeping this a
 * pure mark also keeps the trigger paths from importing the generation/provider
 * chain, and keeps fire-and-forget writes fully drainable in tests.
 *
 * Sets `staleSince=now` even if a generation is in flight; generate.ts commits
 * its result only while it still holds the `generating` status, so a change that
 * lands mid-generation is not lost — the next sweep regenerates.
 */
export function markRoleSkillStale(roleId: string): void {
  const now = new Date();
  trackBestEffort(
    prisma.roleSkill.upsert({
      where: { roleId },
      create: { roleId, status: "stale", staleSince: now },
      // Reset attempts: a genuine content change is a fresh reason to try, so a
      // skill that previously hit MAX_ATTEMPTS (and was parked at 'failed', no
      // longer swept) auto-recovers on the next publish once the provider is
      // healthy again — instead of staying stuck until a manual regenerate.
      update: { status: "stale", staleSince: now, attempts: 0 },
    })
      // 可观测:标脏成功/失败都记一条。此前 upsert 失败被 trackBestEffort 静默吞掉,
      // 生产上「编辑了却没标待更新/没生成」完全无迹可循。
      .then(() => console.info(`[role-skill] marked stale role=${roleId}`))
      .catch((e) => { console.warn(`[role-skill] markStale FAILED role=${roleId}:`, (e as Error).message); throw e; }),
  );
}

/** Ensure a RoleSkill row exists for a freshly-created role (empty + stale so
 *  the dispatcher generates its first skill). Best-effort. */
export function ensureRoleSkillRow(roleId: string): void {
  const now = new Date();
  trackBestEffort(
    prisma.roleSkill.upsert({
      where: { roleId },
      create: { roleId, status: "stale", staleSince: now },
      update: {},
    }),
  );
}
