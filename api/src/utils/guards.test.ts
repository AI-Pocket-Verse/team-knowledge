import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("guards", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser({ ssoId: "admin", displayName: "Admin", isAdmin: true });
    await seedUser({ ssoId: "user1", displayName: "User One", isAdmin: false });
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("requireAdmin returns 401 when unauthenticated", async () => {
    const app = await buildServer(AUTH);
    app.get("/__probe-admin", async (req, reply) => {
      const { requireAdmin } = await import("./guards.js");
      const user = await requireAdmin(req, reply);
      if (!user) return;
      return { ok: true };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-admin" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("requireAdmin returns 403 for a non-admin", async () => {
    const app = await buildServer(AUTH);
    app.get("/__probe-admin", async (req, reply) => {
      const { requireAdmin } = await import("./guards.js");
      const user = await requireAdmin(req, reply);
      if (!user) return;
      return { ok: true };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-admin", headers: { cookie: authCookie("user1") } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    await app.close();
  });

  it("requireAdmin passes for an admin", async () => {
    const app = await buildServer(AUTH);
    app.get("/__probe-admin", async (req, reply) => {
      const { requireAdmin } = await import("./guards.js");
      const user = await requireAdmin(req, reply);
      if (!user) return;
      return { id: user.id };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-admin", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// Auth-robustness (503 vs 401): when the SSO service (:4020) is transiently
// unreachable or erroring, the auth-client-api onRequest hook must set
// req.authTransient so guards answer a RETRYABLE 503 (don't bounce to /login),
// while a definitive logged-out answer (whoami authenticated:false / 4xx) still
// yields 401.
describe("requireUser — transient auth unavailability → 503 (not 401)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  async function probeWith(fetchImpl: typeof fetch) {
    const app = await buildServer({ auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } });
    app.get("/__probe-user", async (req, reply) => {
      const { requireUser } = await import("./guards.js");
      const user = await requireUser(req, reply);
      if (!user) return;
      return { ok: true };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-user", headers: { cookie: authCookie("someone") } });
    await app.close();
    return res;
  }

  it("returns 503 auth_unavailable when whoami fetch throws (network blip)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const res = await probeWith(fetchImpl);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("auth_unavailable");
  });

  it("returns 503 auth_unavailable when whoami returns 5xx (auth restarting)", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 503 })) as typeof fetch;
    const res = await probeWith(fetchImpl);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("auth_unavailable");
  });

  it("returns 401 unauthenticated when whoami says authenticated:false", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const res = await probeWith(fetchImpl);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
  });

  it("returns 401 unauthenticated when whoami returns 4xx (definitely logged out)", async () => {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as typeof fetch;
    const res = await probeWith(fetchImpl);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
  });
});

describe("requireUser JIT provisioning", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("creates a local user on first authenticated request keyed by ssoId", async () => {
    const app = await buildServer(AUTH);
    app.get("/__probe-user", async (req, reply) => {
      const { requireUser } = await import("./guards.js");
      const user = await requireUser(req, reply);
      if (!user) return;
      return { id: user.id, displayName: user.displayName, isAdmin: user.isAdmin };
    });
    expect(await prisma.user.findUnique({ where: { ssoId: "newcomer" } })).toBeNull();
    const res = await app.inject({ method: "GET", url: "/__probe-user", headers: { cookie: authCookie("newcomer") } });
    expect(res.statusCode).toBe(200);
    // Bootstrap allowlist is empty in tests → non-admin.
    expect(res.json().isAdmin).toBe(false);
    expect(await prisma.user.findUnique({ where: { ssoId: "newcomer" } })).not.toBeNull();
    await app.close();
  });

  it("returns 403 inactive when the local user has been deactivated", async () => {
    await seedUser({ ssoId: "banned", displayName: "Banned", isActive: false });
    const app = await buildServer(AUTH);
    app.get("/__probe-user", async (req, reply) => {
      const { requireUser } = await import("./guards.js");
      const user = await requireUser(req, reply);
      if (!user) return;
      return { ok: true };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-user", headers: { cookie: authCookie("banned") } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("inactive");
    await app.close();
  });
});

// A whoami mock where the auth cuid (`id`) and the Feishu `open_id` DIFFER —
// the real-world condition the default mockAuth (id === open_id) can't model.
// Proves requireUser anchors the local user on the STABLE open_id and stops
// forking identity when auth's cuid changes (the prod bug: an auth-DB reset
// minted a new cuid → the same Feishu account became a new empty user).
function authSplit(id: string, openId: string) {
  const fetchImpl = (async (): Promise<Response> => {
    const now = new Date().toISOString();
    return new Response(
      JSON.stringify({
        authenticated: true,
        user: {
          id, open_id: openId, union_id: null, name: `User ${openId}`,
          en_name: null, email: null, mobile: null, avatar_url: null,
          avatar_thumb: null, tenant_key: null, last_login_at: now,
        },
        session: {
          id: "sess", user_id: id, remember_me: false,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(), last_seen_at: now,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
}

async function probeMe(cfg: ReturnType<typeof authSplit>) {
  const app = await buildServer(cfg);
  app.get("/__probe-user", async (req, reply) => {
    const { requireUser } = await import("./guards.js");
    const user = await requireUser(req, reply);
    if (!user) return;
    return { id: user.id, ssoId: user.ssoId };
  });
  const res = await app.inject({ method: "GET", url: "/__probe-user", headers: { cookie: "sso_session=x" } });
  await app.close();
  return res;
}

describe("requireUser — local single-user mode (no WHOAMI_URL)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("provisions the local user as admin on the first request, and reuses it afterwards", async () => {
    // No whoamiUrl → auth-client-api attaches LOCAL_USER to every request.
    const app = await buildServer({});
    app.get("/__probe-local", async (req, reply) => {
      const { requireUser } = await import("./guards.js");
      const user = await requireUser(req, reply);
      if (!user) return;
      return { id: user.id, ssoId: user.ssoId, isAdmin: user.isAdmin };
    });
    const first = await app.inject({ method: "GET", url: "/__probe-local" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ssoId: "local", isAdmin: true });
    const second = await app.inject({ method: "GET", url: "/__probe-local" });
    expect(second.json().id).toBe(first.json().id);
    expect(await prisma.user.count()).toBe(1);
    await app.close();
  });
});

describe("requireUser — identity anchored on Feishu open_id", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("keys a brand-new local user on open_id, not the auth cuid", async () => {
    const res = await probeMe(authSplit("auth-cuid-NEW", "ou_newbie"));
    expect(res.statusCode).toBe(200);
    expect(res.json().ssoId).toBe("ou_newbie");
    expect(await prisma.user.findUnique({ where: { ssoId: "auth-cuid-NEW" } })).toBeNull();
  });

  it("returns the SAME local user after the auth cuid changes — no more forking", async () => {
    await probeMe(authSplit("cuid-A", "ou_same")); // first login under cuid A
    const firstId = (await prisma.user.findUniqueOrThrow({ where: { ssoId: "ou_same" } })).id;

    // Auth DB reset → SAME Feishu account now arrives with a new cuid B, same
    // open_id. Pre-fix this minted a second user; now it must reuse the first.
    await probeMe(authSplit("cuid-B", "ou_same"));

    expect(await prisma.user.count()).toBe(1);
    const sameId = (await prisma.user.findUniqueOrThrow({ where: { ssoId: "ou_same" } })).id;
    expect(sameId).toBe(firstId);
  });
});

// a DEACTIVATED bootstrap admin (in ADMIN_OPEN_IDS) must NOT be re-promoted
// to isAdmin on login — pre-fix it was, creating a zombie that flipped admin
// back on every request yet was bounced by the isActive check, impossible to
// keep demoted. The allowlist is parsed once at guards.ts load, so we set the
// env var, reset modules, and import a FRESH buildServer/prisma that see it.
describe("requireUser — deactivated bootstrap admin is not re-promoted", () => {
  const prevOpenIds = process.env.ADMIN_OPEN_IDS;
  // Each test below loads a FRESH module graph (so guards.ts re-reads the env
  // allowlist), which instantiates a SECOND live PrismaClient on the shared
  // test.db. Track its disconnectDb and close it in afterEach — otherwise the
  // 2nd connection leaks past this file and contends with the next file's
  // singleton on the single SQLite file (the documented cross-file flakiness).
  let disconnectFresh: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (prevOpenIds === undefined) delete process.env.ADMIN_OPEN_IDS;
    else process.env.ADMIN_OPEN_IDS = prevOpenIds;
    if (disconnectFresh) {
      await disconnectFresh();
      disconnectFresh = null;
    }
    vi.resetModules();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("keeps a deactivated bootstrap admin deactivated AND un-promoted", async () => {
    process.env.ADMIN_OPEN_IDS = "ou_zombie";
    vi.resetModules();
    const { prisma: freshPrisma, disconnectDb: freshDisconnect } = await import("../db.js");
    disconnectFresh = freshDisconnect;
    const { resetDb: freshReset } = await import("../../test-helpers/db.js");
    const { buildServer: fresh } = await import("../server.js");
    await freshReset();
    // Bootstrap admin (open_id in allowlist) who has been deactivated + demoted.
    await freshPrisma.user.create({
      data: { ssoId: "ou_zombie", displayName: "Zombie", isAdmin: false, isActive: false },
    });

    const app = await fresh(AUTH);
    app.get("/__probe-user", async (req, reply) => {
      const { requireUser } = await import("./guards.js");
      const user = await requireUser(req, reply);
      if (!user) return;
      return { id: user.id, isAdmin: user.isAdmin };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-user", headers: { cookie: authCookie("ou_zombie") } });
    // Still bounced as inactive (not silently re-enabled) …
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("inactive");
    // … and crucially NOT re-promoted to admin behind the scenes.
    const row = await freshPrisma.user.findUniqueOrThrow({ where: { ssoId: "ou_zombie" } });
    expect(row.isAdmin).toBe(false);
    expect(row.isActive).toBe(false);
    await app.close();
  });

  it("an ACTIVE bootstrap admin IS still re-promoted (regression guard)", async () => {
    process.env.ADMIN_OPEN_IDS = "ou_owner";
    vi.resetModules();
    const { prisma: freshPrisma, disconnectDb: freshDisconnect } = await import("../db.js");
    disconnectFresh = freshDisconnect;
    const { resetDb: freshReset } = await import("../../test-helpers/db.js");
    const { buildServer: fresh } = await import("../server.js");
    await freshReset();
    await freshPrisma.user.create({
      data: { ssoId: "ou_owner", displayName: "Owner", isAdmin: false, isActive: true },
    });

    const app = await fresh(AUTH);
    app.get("/__probe-user", async (req, reply) => {
      const { requireUser } = await import("./guards.js");
      const user = await requireUser(req, reply);
      if (!user) return;
      return { isAdmin: user.isAdmin };
    });
    const res = await app.inject({ method: "GET", url: "/__probe-user", headers: { cookie: authCookie("ou_owner") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().isAdmin).toBe(true);
    expect((await freshPrisma.user.findUniqueOrThrow({ where: { ssoId: "ou_owner" } })).isAdmin).toBe(true);
    await app.close();
  });
});
