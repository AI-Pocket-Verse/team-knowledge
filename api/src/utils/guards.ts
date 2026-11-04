import { L } from "./lang.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { LOCAL_USER } from "@team-knowledge/auth-core";
import { env } from "../env.js";
import { beijingDayKey } from "./day.js";
import { notifyAdminsOfNewUser } from "./notify/adminAlert.js";

// Update `lastSeenAt` + mark today's UserActiveDay at most once per this
// window per user, so the per-request cost of activity tracking is ~zero
// on the hot path (the decision reads the already-fetched row).
const ACTIVITY_THROTTLE_MS = 10 * 60 * 1000;

// Fire-and-forget best-effort writes (the activity stamp below) are not
// awaited by the request, which is correct in prod but in tests lets a write
// outlive its test and race the NEXT test file's resetDb on the shared SQLite
// DB (single-writer → "database is locked" / cross-file contamination). We
// register each in-flight promise so the test harness can drain them before
// resetting. `flushBestEffortWrites` is only ever called by tests; prod never
// touches it, so this adds zero runtime cost on the hot path.
const pendingBestEffortWrites = new Set<Promise<unknown>>();
export function flushBestEffortWrites(): Promise<unknown> {
  return Promise.allSettled([...pendingBestEffortWrites]);
}
// Exported so other fire-and-forget side effects (e.g. emitNotification on
// like/comment/favorite) register here too — keeping the suite deterministic
// without each route test having to mock the side effect.
export function trackBestEffort(p: Promise<unknown>): void {
  // .catch first so a failed best-effort write can never reject; .finally
  // de-registers so the set doesn't grow unbounded.
  const tracked = p.catch(() => {}).finally(() => { pendingBestEffortWrites.delete(tracked); });
  pendingBestEffortWrites.add(tracked);
}

// Best-effort, fire-and-forget activity stamp. Never blocks or fails the
// request — telemetry only (powers the admin dashboard). Throttled via the
// row's own lastSeenAt so it works correctly across multiple processes.
function recordActivity(user: { id: string; lastSeenAt: Date | null }): void {
  const now = new Date();
  if (user.lastSeenAt && now.getTime() - user.lastSeenAt.getTime() < ACTIVITY_THROTTLE_MS) return;
  const day = beijingDayKey(now);
  trackBestEffort(
    prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: now } }),
      prisma.userActiveDay.upsert({
        where: { userId_day: { userId: user.id, day } },
        create: { userId: user.id, day },
        update: {},
      }),
    ]),
  );
}

// Bootstrap-admin allowlists, parsed once at module load. A freshly
// JIT-provisioned local user is created with isAdmin=true when their SSO
// open_id is in ADMIN_OPEN_IDS, their SSO email (lowercased) is in
// ADMIN_EMAILS, or their SSO mobile is in ADMIN_PHONES. After bootstrap,
// admins manage roles / admin in-app.
const ADMIN_OPEN_IDS = new Set(env.ADMIN_OPEN_IDS.split(",").map((s) => s.trim()).filter(Boolean));
const ADMIN_EMAILS = new Set(env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
// Normalize a phone to its bare national number: drop non-digits + a leading
// country code (86), so `+8613...`, `86 137...` and `137...` all compare equal.
const normPhone = (p: string): string => p.replace(/\D/g, "").replace(/^86/, "");
const ADMIN_PHONES = new Set(env.ADMIN_PHONES.split(",").map((s) => normPhone(s)).filter(Boolean));

function isBootstrapAdmin(sso: { open_id: string; email?: string | null; mobile?: string | null }): boolean {
  // 本地单用户模式（未配置 WHOAMI_URL）：唯一的本地用户就是管理员。
  // LOCAL_USER 只在没有 whoami 时出现，SSO 用户的 open_id 不会等于它。
  if (sso.open_id === LOCAL_USER.open_id) return true;
  if (ADMIN_OPEN_IDS.has(sso.open_id)) return true;
  if (sso.email && ADMIN_EMAILS.has(sso.email.toLowerCase())) return true;
  if (sso.mobile && ADMIN_PHONES.has(normPhone(sso.mobile))) return true;
  return false;
}

// Row-based bootstrap-admin check for the admin-users PATCH guard. The stored
// User row carries `ssoId` (= the Feishu open_id) + `email`, but NOT mobile, so
// a phone-only bootstrap admin can't be recognized from the DB row alone (the
// guards.ts re-assertion fix covers that case at login time). Exact matches on
// open_id / email never yield a false positive.
export function isBootstrapAdminRow(user: { ssoId: string | null; email: string | null }): boolean {
  if (user.ssoId && ADMIN_OPEN_IDS.has(user.ssoId)) return true;
  if (user.email && ADMIN_EMAILS.has(user.email.toLowerCase())) return true;
  return false;
}

// Maps the SSO identity (populated by @team-knowledge/auth-client-api's
// onRequest hook) to team-knowledge's own local User row, JIT-provisioning it
// on first authenticated request. Returns the local User, or null after
// having already sent a 401/403 reply (callers `if (!user) return;`).
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const sso = req.user; // populated by @team-knowledge/auth-client-api
  if (!sso) {
    // Distinguish "SSO temporarily unreachable" (retryable, don't log out)
    // from "confirmed not logged in". req.authTransient is set by the
    // auth-client-api onRequest hook when whoami blipped / returned 5xx.
    if (req.authTransient) {
      reply.code(503).send({ error: "auth_unavailable", message: L(req, "登录服务暂时不可用,请稍后重试", "Sign-in service is temporarily unavailable. Try again later") });
      return null;
    }
    reply.code(401).send({ error: "unauthenticated", message: L(req, "请先登录", "Sign in first") });
    return null;
  }
  // Key the local user on the STABLE Feishu open_id — NOT feishu-sso's cuid
  // (sso.id), which changes whenever its DB is reset or relocated and would
  // fork the same Feishu account into a brand-new local user. open_id never
  // changes for the same account + app, so it is the correct anchor.
  let user = await prisma.user.findUnique({ where: { ssoId: sso.open_id } });

  if (!user) {
    try {
      user = await prisma.user.create({
        data: {
          ssoId: sso.open_id,
          email: sso.email ?? null,
          displayName: sso.name,
          avatarUrl: sso.avatar_url ?? null,
          isAdmin: isBootstrapAdmin(sso),
          isActive: true,
        },
      });
      // Brand-new signup (this is the ONLY truly-first-login branch — the P2002
      // path below just re-reads a row someone else created). Heads-up the
      // admins on Feishu so they can assign the newcomer a role. Best-effort +
      // fire-and-forget: never blocks/fails login. Skipped for a new bootstrap
      // admin (they don't need a role). trackBestEffort registers it so the
      // test harness can drain it instead of racing the next resetDb.
      if (!user.isAdmin) trackBestEffort(notifyAdminsOfNewUser(user));
    } catch (e) {
      // Concurrent first request already created it — re-read.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        user = await prisma.user.findUnique({ where: { ssoId: sso.open_id } });
      } else {
        throw e;
      }
    }
  }
  // The owner / bootstrap admins (ADMIN_PHONES · ADMIN_EMAILS · ADMIN_OPEN_IDS)
  // are always admin on login — re-assert even for an EXISTING row that isn't
  // admin yet (provisioned before the allowlist, or demoted by mistake), so the
  // owner can never be locked out of the admin role. Admins
  // keep full (super) access to every role's content; the per-user role
  // checkboxes are just convenience defaults for them (admins bypass role gates).
  //
  // GUARD: skip the re-assertion for a DEACTIVATED row. Otherwise a bootstrap
  // admin who was deactivated became a zombie — re-promoted to isAdmin on every
  // login here, yet bounced by the isActive check just below, and impossible to
  // keep demoted. A deactivated bootstrap admin stays deactivated + un-promoted;
  // re-enabling them requires the admin-users API (which itself guards bootstrap
  // admins) or fixing the env allowlist.
  if (user && user.isActive && !user.isAdmin && isBootstrapAdmin(sso)) {
    user = await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } });
  }

  if (!user || !user.isActive) {
    reply.code(403).send({ error: "inactive", message: L(req, "账号已被停用", "This account has been deactivated") });
    return null;
  }
  recordActivity(user);
  return user;
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (!user.isAdmin) {
    reply.code(403).send({ error: "forbidden", message: L(req, "需要管理员权限", "Admin permission required") });
    return null;
  }
  return user;
}
