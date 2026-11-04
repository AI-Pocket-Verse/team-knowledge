import { execSync } from "node:child_process";
import { prisma } from "../src/db.js";
import { flushBestEffortWrites } from "../src/utils/guards.js";
import type { Prisma } from "@prisma/client";

export async function resetDb(): Promise<void> {
  // Drain any in-flight fire-and-forget writes (e.g. the activity stamp in
  // guards.recordActivity) BEFORE wiping — otherwise a write scheduled by the
  // previous test can land mid-delete on the shared single-writer SQLite DB
  // and contaminate this test / flake the suite.
  await flushBestEffortWrites();
  // Order matters: delete dependent rows first.
  // AssistantExclusion has no FKs (targetId is a loose ref to role/folder/article),
  // so it can go first. MUST be wiped — otherwise excluded ids leak across test
  // files (resetDb runs per beforeEach) and poison unrelated suites' retrieval /
  // audit results, plus collide on the (targetType,targetId) unique index.
  await prisma.assistantExclusion.deleteMany();
  // P1 专家:Escalation 无外键(不被级联);RoleExpert 虽随 Role 级联,显式清更稳。
  await prisma.escalation.deleteMany();
  await prisma.roleExpert.deleteMany();
  // Conversation cascades ChatMessage via FK; deleting chat msgs first is
  // defensive in case a future schema drops the cascade.
  await prisma.meetingComment.deleteMany();
  await prisma.meetingTranscript.deleteMany();
  await prisma.meetingSession.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.articleReference.deleteMany();
  await prisma.bookmark.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationPref.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.folder.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.roleSkill.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany();
}

export async function ensureMigrated(): Promise<void> {
  execSync("pnpm prisma migrate deploy", { cwd: process.cwd(), stdio: "ignore" });
}

// ─── SSO auth mocking ──────────────────────────────────────────────
// team-knowledge now authenticates via @team-knowledge/auth-client-api, which on
// every request validates the `sso_session` cookie by calling a whoami
// URL. Tests can't reach a live Feishu / auth service, so we inject a
// `fetchImpl` into buildServer({ auth: { whoamiUrl, fetchImpl } }) that
// answers whoami deterministically: the `sso_session` value IS the ssoId.
//
// The returned JSON matches @team-knowledge/auth-core's WhoamiResponse zod
// schema exactly (authenticated + user + session). requireUser keys the
// local User off `user.id` (= the ssoId), so a test seeds a local row
// with `seedUser({ ssoId })` and sends `cookie: authCookie(ssoId)`.

const WHOAMI_COOKIE_NAME = "sso_session";

/** Cookie header value carrying the given ssoId as the sso_session id. */
export function authCookie(ssoId: string): string {
  return `${WHOAMI_COOKIE_NAME}=${encodeURIComponent(ssoId)}`;
}

export interface MockAuth {
  /** A `typeof fetch` to pass into buildServer's auth.fetchImpl. */
  fetchImpl: typeof fetch;
  /** Convenience: the sso_session cookie header for an ssoId. */
  cookie: (ssoId: string) => string;
}

/**
 * Build a mocked whoami fetch. It reads the `sso_session` value out of the
 * outgoing request's Cookie header (the auth client sends it as
 * `sso_session=<sid>`) and replies as if that sid is an authenticated SSO
 * user whose id/open_id are the sid. Display fields are synthetic but
 * schema-valid. When no sso_session cookie is present it returns the
 * `{ authenticated: false }` branch.
 */
export function mockAuth(): MockAuth {
  const fetchImpl = (async (_input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const cookieHeader = readCookieHeader(init?.headers);
    const sid = parseCookie(cookieHeader, WHOAMI_COOKIE_NAME);
    if (!sid) {
      return jsonResponse({ authenticated: false });
    }
    const now = new Date().toISOString();
    return jsonResponse({
      authenticated: true,
      user: {
        id: sid,
        open_id: sid,
        union_id: null,
        name: `User ${sid}`,
        en_name: null,
        email: null,
        mobile: null,
        avatar_url: null,
        avatar_thumb: null,
        tenant_key: null,
        last_login_at: now,
      },
      session: {
        id: `sess-${sid}`,
        user_id: sid,
        remember_me: false,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        last_seen_at: now,
      },
    });
  }) as typeof fetch;
  return { fetchImpl, cookie: authCookie };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readCookieHeader(headers: RequestInit["headers"]): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("cookie") ?? headers.get("Cookie") ?? undefined;
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === "cookie") return v;
    }
    return undefined;
  }
  const rec = headers as Record<string, string>;
  return rec.cookie ?? rec.Cookie;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const k = piece.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(piece.slice(eq + 1).trim());
  }
  return undefined;
}

// ─── Local user seeding ────────────────────────────────────────────
// Local team-knowledge users are now keyed by `ssoId` (the SSO identity id).
// requireUser JIT-provisions on first request, but tests usually need a
// row up-front (to attach roles / set isAdmin / be referenced as an
// author), so they seed explicitly with a chosen ssoId and then send
// `cookie: authCookie(ssoId)` to act as that user.

export interface SeedUserOptions {
  ssoId: string;
  displayName?: string;
  email?: string | null;
  isAdmin?: boolean;
  isActive?: boolean;
  avatarUrl?: string | null;
}

export async function seedUser(opts: SeedUserOptions) {
  return prisma.user.create({
    data: {
      ssoId: opts.ssoId,
      displayName: opts.displayName ?? opts.ssoId,
      email: opts.email ?? null,
      isAdmin: opts.isAdmin ?? false,
      isActive: opts.isActive ?? true,
      avatarUrl: opts.avatarUrl ?? null,
    },
  });
}

/** Seed an admin user. ssoId defaults to "admin" so tests can act as it
 *  via `authCookie("admin")`. Accepts prisma overrides for extra fields. */
export async function seedAdmin(overrides: Partial<Prisma.UserCreateInput> = {}) {
  return prisma.user.create({
    data: {
      ssoId: "admin",
      displayName: "Admin",
      isAdmin: true,
      ...overrides,
    },
  });
}
