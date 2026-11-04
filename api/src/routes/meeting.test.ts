import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { _resetLifecycleForTests } from "../services/meeting/lifecycle.js";
import { env } from "../env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// Minimal-but-valid create body (all config defaults are covered by
// the schema's `.default()` chain, so passing {} should work too —
// but we set tts=false here to avoid implying TTS work in these tests).
function validBody(roleId: string) {
  return {
    title: "V2 评审会",
    allowedRoleIds: [roleId],
    config: {
      tts: false,
      recording: true,
      freqLimitMinutes: 5, freqLimitMessages: 1,
      triggerSilence: true,
      triggerKeyword: true,
      durationHintHours: 4,
      style: "neutral",
    },
  };
}

async function seedRole(name = "产品") {
  return prisma.role.create({ data: { name, color: "#8b5cf6" } });
}

async function seedNonAdmin(ssoId = "u") {
  return prisma.user.create({
    data: {
      ssoId,
      displayName: ssoId.toUpperCase(),
      isAdmin: false,
    },
  });
}

describe("/api/meeting", () => {
  beforeEach(async () => { await resetDb(); _resetLifecycleForTests(); });
  afterAll(async () => { await disconnectDb(); });

  it("POST requires auth", async () => {
    const role = await seedRole();
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "POST", url: "/api/meeting", payload: validBody(role.id) });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("POST allows any logged-in user (incl. non-admin) and defaults to public", async () => {
    const role = await seedRole();
    await seedNonAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");
    const r = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    expect(r.statusCode).toBe(200);
    expect(r.json().session.visibility).toBe("public");
    await app.close();
  });

  it("POST 400 when title missing", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST",
      url: "/api/meeting",
      headers: { cookie },
      payload: { ...validBody(role.id), title: "  " },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("POST allows empty allowedRoleIds (AI retrieves public docs only)", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST",
      url: "/api/meeting",
      headers: { cookie },
      payload: { ...validBody("placeholder"), allowedRoleIds: [] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().session.allowedRoleIds).toEqual([]);
    await app.close();
  });

  it("POST 400 when allowedRoleIds reference unknown role", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST",
      url: "/api/meeting",
      headers: { cookie },
      payload: validBody("ghost-role-id"),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/无效的角色/);
    await app.close();
  });

  it("POST 200 returns session with serialized roles + host", async () => {
    const role = await seedRole();
    const admin = await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.session.title).toBe("V2 评审会");
    expect(body.session.status).toBe("active");
    expect(body.session.hostUserId).toBe(admin.id);
    expect(body.session.hostName).toBe("Admin");
    expect(body.session.allowedRoles).toEqual([{ id: role.id, name: "产品", color: "#8b5cf6" }]);
    expect(body.session.config.freqLimitMinutes).toBe(5);
    expect(body.session.config.style).toBe("neutral");
    await app.close();
  });

  it("POST 409 when same admin already hosts an active meeting (single active meeting per host)", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const first = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    expect(second.statusCode).toBe(409);
    expect(second.json().activeMeetingId).toBe(first.json().session.id);
    await app.close();
  });

  it("POST allows two DIFFERENT admins to each have one active meeting", async () => {
    const role = await seedRole();
    await seedAdmin();
    await prisma.user.create({
      data: { ssoId: "admin2", displayName: "Admin2", isAdmin: true },
    });
    const app = await buildServer(AUTH);
    const c1 = authCookie("admin");
    const c2 = authCookie("admin2");
    const r1 = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: c1 }, payload: validBody(role.id) });
    const r2 = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: c2 }, payload: validBody(role.id) });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    await app.close();
  });

  it("GET /hub returns active + recent for any logged-in user", async () => {
    const role = await seedRole();
    await seedAdmin();
    await seedNonAdmin();
    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: adminCookie }, payload: validBody(role.id) });

    const userCookie = authCookie("u");
    const r = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie: userCookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.active).toHaveLength(1);
    expect(body.recent).toHaveLength(0);
    await app.close();
  });

  it("GET /hub requires auth", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "GET", url: "/api/meeting/hub" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("GET /:id 404 on unknown id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "GET", url: "/api/meeting/no-such-id", headers: { cookie } });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("GET /:id returns session + empty transcripts + empty comments", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    const id = c.json().session.id;
    const r = await app.inject({ method: "GET", url: `/api/meeting/${id}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.session.id).toBe(id);
    expect(body.transcripts).toEqual([]);
    expect(body.comments).toEqual([]);
    await app.close();
  });

  it("DELETE by host ends meeting (status flips, endedAt set)", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    const id = c.json().session.id;
    const d = await app.inject({ method: "DELETE", url: `/api/meeting/${id}`, headers: { cookie } });
    expect(d.statusCode).toBe(200);
    expect(d.json().session.status).toBe("ended");
    expect(d.json().session.endedAt).toBeTruthy();
    await app.close();
  });

  it("DELETE by other admin also works (admin override on stuck meetings)", async () => {
    const role = await seedRole();
    await seedAdmin();
    await prisma.user.create({
      data: { ssoId: "admin2", displayName: "Admin2", isAdmin: true },
    });
    const app = await buildServer(AUTH);
    const c1 = authCookie("admin");
    const c2 = authCookie("admin2");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: c1 }, payload: validBody(role.id) });
    const id = c.json().session.id;
    const d = await app.inject({ method: "DELETE", url: `/api/meeting/${id}`, headers: { cookie: c2 } });
    expect(d.statusCode).toBe(200);
    expect(d.json().session.status).toBe("ended");
    await app.close();
  });

  it("DELETE by non-admin non-host 403", async () => {
    const role = await seedRole();
    await seedAdmin();
    await seedNonAdmin();
    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: adminCookie }, payload: validBody(role.id) });
    const id = c.json().session.id;
    const userCookie = authCookie("u");
    const d = await app.inject({ method: "DELETE", url: `/api/meeting/${id}`, headers: { cookie: userCookie } });
    expect(d.statusCode).toBe(403);
    await app.close();
  });

  it("DELETE on already-ended meeting is idempotent (200)", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    const id = c.json().session.id;
    const d1 = await app.inject({ method: "DELETE", url: `/api/meeting/${id}`, headers: { cookie } });
    const d2 = await app.inject({ method: "DELETE", url: `/api/meeting/${id}`, headers: { cookie } });
    expect(d1.statusCode).toBe(200);
    expect(d2.statusCode).toBe(200);
    expect(d2.json().session.status).toBe("ended");
    await app.close();
  });

  it("after ending, same admin can start a NEW meeting (single-active is per status=active)", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c1 = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    await app.inject({ method: "DELETE", url: `/api/meeting/${c1.json().session.id}`, headers: { cookie } });
    const c2 = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    expect(c2.statusCode).toBe(200);
    expect(c2.json().session.id).not.toBe(c1.json().session.id);
    await app.close();
  });

  it("/hub batch-loads roles + host names correctly across multiple sessions (N+1 fix)", async () => {
    // Two distinct hosts, two distinct roles — proves the batched
    // role/host maps key each session's display info to the RIGHT row
    // (a broken batch would cross-wire host names or role sets).
    const product = await seedRole("产品");
    const eng = await seedRole("研发");
    await seedAdmin(); // ssoId "admin", displayName "Admin"
    await prisma.user.create({ data: { ssoId: "admin2", displayName: "Admin2", isAdmin: true } });
    const app = await buildServer(AUTH);
    const c1 = authCookie("admin");
    const c2 = authCookie("admin2");
    await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: c1 },
      payload: { ...validBody(product.id), title: "产品会" } });
    await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: c2 },
      payload: { ...validBody(eng.id), title: "研发会" } });

    const r = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie: c1 } });
    expect(r.statusCode).toBe(200);
    const active = r.json().active as Array<{
      title: string; hostName: string; allowedRoles: Array<{ id: string; name: string }>;
    }>;
    const byTitle = new Map(active.map((m) => [m.title, m] as const));
    expect(byTitle.get("产品会")?.hostName).toBe("Admin");
    expect(byTitle.get("产品会")?.allowedRoles).toEqual([{ id: product.id, name: "产品", color: "#8b5cf6" }]);
    expect(byTitle.get("研发会")?.hostName).toBe("Admin2");
    expect(byTitle.get("研发会")?.allowedRoles).toEqual([{ id: eng.id, name: "研发", color: "#8b5cf6" }]);
    await app.close();
  });

  it("GET /:id returns the FULL transcript (no cap) in ascending order", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    const id = c.json().session.id;

    // Seed 520 transcript rows (well past the old 500 cap) directly. startMs
    // encodes ordinal so we can assert EVERY row came back + ascending order.
    const TOTAL = 520;
    await prisma.meetingTranscript.createMany({
      data: Array.from({ length: TOTAL }, (_, i) => ({
        sessionId: id, text: `seg${i}`, startMs: i * 1000, endMs: i * 1000 + 500,
      })),
    });

    const r = await app.inject({ method: "GET", url: `/api/meeting/${id}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const transcripts = r.json().transcripts as Array<{ text: string; startMs: number }>;
    // Complete transcription — all 520 segments, no truncation, seg0..seg519.
    expect(transcripts).toHaveLength(TOTAL);
    expect(transcripts[0]!.text).toBe("seg0");
    expect(transcripts.at(-1)!.text).toBe("seg519");
    // Ascending by startMs (frontend appends WS deltas chronologically).
    for (let i = 1; i < transcripts.length; i++) {
      expect(transcripts[i]!.startMs).toBeGreaterThan(transcripts[i - 1]!.startMs);
    }
    await app.close();
  });

  it("GET /:id/recording with ?download=1 names the file after the meeting title", async () => {
    const admin = await seedAdmin();
    const session = await prisma.meetingSession.create({
      data: {
        title: "产品评审会", createdById: admin.id, allowedRoleIds: "[]", config: "{}",
        status: "ended", visibility: "public",
      },
    });
    await prisma.meetingSession.update({
      where: { id: session.id },
      data: { recordingUrl: `/meeting-recordings/${session.id}.wav` },
    });
    const recDir = resolve(join(env.DATA_DIR, "meeting-recordings"));
    await mkdir(recDir, { recursive: true });
    await writeFile(join(recDir, `${session.id}.wav`), Buffer.from("RIFF0000WAVEfake"));

    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // ?download=1 → attachment with the meeting title (RFC 5987 for CJK).
    const dl = await app.inject({ method: "GET", url: `/api/meeting-recordings/${session.id}.wav?download=1`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("audio/wav");
    const cd = String(dl.headers["content-disposition"]);
    expect(cd).toContain("attachment");
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("产品评审会")}.wav`);
    // No ?download → inline playback (unchanged).
    const play = await app.inject({ method: "GET", url: `/api/meeting-recordings/${session.id}.wav`, headers: { cookie } });
    expect(String(play.headers["content-disposition"])).toContain("inline");
    await app.close();
  });

  it("GET /:id batch-resolves comment triggeredByName + caps comments", async () => {
    const role = await seedRole();
    await seedAdmin();
    const asker = await seedNonAdmin("asker"); // displayName "ASKER"
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    const id = c.json().session.id;

    // One user-triggered comment (name must resolve via the batch) + 210
    // natural-trigger comments (> the 200 cap) with null triggeredByUserId.
    await prisma.meetingComment.create({
      data: { sessionId: id, triggerType: "user_question", triggeredByUserId: asker.id, text: "Q1", atMs: 0 },
    });
    await prisma.meetingComment.createMany({
      data: Array.from({ length: 210 }, (_, i) => ({
        sessionId: id, triggerType: "silence", triggeredByUserId: null, text: `c${i}`, atMs: (i + 1) * 1000,
      })),
    });

    const r = await app.inject({ method: "GET", url: `/api/meeting/${id}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const comments = r.json().comments as Array<{ text: string; atMs: number; triggeredByName: string | null }>;
    // Capped at 200, ascending by atMs, and the most recent window.
    expect(comments).toHaveLength(200);
    expect(comments.at(-1)!.text).toBe("c209");
    for (let i = 1; i < comments.length; i++) {
      expect(comments[i]!.atMs).toBeGreaterThan(comments[i - 1]!.atMs);
    }
    await app.close();
  });

  it("GET /meeting-tts/:filename rejects an implausible per-sentence seq", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const c = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: validBody(role.id) });
    const id = c.json().session.id;
    const comment = await prisma.meetingComment.create({
      data: { sessionId: id, triggerType: "silence", triggeredByUserId: null, text: "hi", atMs: 0 },
    });
    // Absurd seq (> the 4-digit bound) is rejected before any fs lookup.
    const bad = await app.inject({ method: "GET", url: `/api/meeting-tts/${comment.id}-999999999.mp3`, headers: { cookie } });
    expect(bad.statusCode).toBe(404);
    await app.close();
  });

  it("/hub places ended meetings in `recent`, sorted by endedAt desc", async () => {
    const role = await seedRole();
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const a = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: { ...validBody(role.id), title: "A" } });
    await app.inject({ method: "DELETE", url: `/api/meeting/${a.json().session.id}`, headers: { cookie } });
    // Tiny gap so endedAt timestamps differ even on fast machines.
    await new Promise((r) => setTimeout(r, 5));
    const b = await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie }, payload: { ...validBody(role.id), title: "B" } });
    await app.inject({ method: "DELETE", url: `/api/meeting/${b.json().session.id}`, headers: { cookie } });

    const r = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie } });
    const recent = r.json().recent as { title: string }[];
    expect(recent.map((m) => m.title)).toEqual(["B", "A"]);
    await app.close();
  });
});

// ── Visibility (public/private) + edit ─────────────────────────
describe("/api/meeting visibility", () => {
  beforeEach(async () => { await resetDb(); _resetLifecycleForTests(); });
  afterAll(async () => { await disconnectDb(); });

  // host + stranger are non-admins; admin is the bootstrap admin.
  async function seedTrio() {
    await seedAdmin(); // ssoId "admin"
    await prisma.user.create({ data: { ssoId: "host", displayName: "Host", isAdmin: false } });
    await prisma.user.create({ data: { ssoId: "stranger", displayName: "Stranger", isAdmin: false } });
  }
  const body = (over: Record<string, unknown> = {}) => ({ title: "私密会", allowedRoleIds: [], config: {}, ...over });
  const createPrivate = (app: Awaited<ReturnType<typeof buildServer>>) =>
    app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: authCookie("host") }, payload: body({ visibility: "private" }) });

  it("create persists private visibility", async () => {
    await seedTrio();
    const app = await buildServer(AUTH);
    const r = await createPrivate(app);
    expect(r.statusCode).toBe(200);
    expect(r.json().session.visibility).toBe("private");
    await app.close();
  });

  it("hub hides a private meeting from everyone but its creator — incl. admins", async () => {
    await seedTrio();
    const app = await buildServer(AUTH);
    await createPrivate(app);
    const has = async (ssoId: string) => {
      const r = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie: authCookie(ssoId) } });
      return (r.json().active as { title: string }[]).some((m) => m.title === "私密会");
    };
    expect(await has("stranger")).toBe(false);
    expect(await has("host")).toBe(true);
    expect(await has("admin")).toBe(false); // admin (not the creator) gets no bypass
    await app.close();
  });

  it("detail 404s a private meeting for everyone but its creator — incl. admins", async () => {
    await seedTrio();
    const app = await buildServer(AUTH);
    const id = (await createPrivate(app)).json().session.id;
    const code = async (ssoId: string) =>
      (await app.inject({ method: "GET", url: `/api/meeting/${id}`, headers: { cookie: authCookie(ssoId) } })).statusCode;
    expect(await code("stranger")).toBe(404);
    expect(await code("host")).toBe(200);
    expect(await code("admin")).toBe(404); // admin (not the creator) gets no bypass — existence hidden
    await app.close();
  });

  it("PATCH visibility: on a PUBLIC meeting creator flips it (stranger 403, admin allowed); once PRIVATE, a non-creator admin is 404'd", async () => {
    await seedTrio();
    const app = await buildServer(AUTH);
    const id = (await app.inject({ method: "POST", url: "/api/meeting", headers: { cookie: authCookie("host") },
      payload: body({ title: "可编辑", visibility: "public" }) })).json().session.id;

    // While still PUBLIC: a stranger can view it but can't edit (403);
    // an admin CAN edit (canViewMeeting passes on public, canEditMeetingMeta
    // grants admins). Admin renames it but keeps it public.
    const strangerPatch = await app.inject({ method: "PATCH", url: `/api/meeting/${id}`,
      headers: { cookie: authCookie("stranger") }, payload: { visibility: "private" } });
    expect(strangerPatch.statusCode).toBe(403);

    const adminPatchWhilePublic = await app.inject({ method: "PATCH", url: `/api/meeting/${id}`,
      headers: { cookie: authCookie("admin") }, payload: { title: "改名了" } });
    expect(adminPatchWhilePublic.statusCode).toBe(200);
    expect(adminPatchWhilePublic.json().session.title).toBe("改名了");

    // Creator flips it to PRIVATE.
    const hostPatch = await app.inject({ method: "PATCH", url: `/api/meeting/${id}`,
      headers: { cookie: authCookie("host") }, payload: { visibility: "private" } });
    expect(hostPatch.statusCode).toBe(200);
    expect(hostPatch.json().session.visibility).toBe("private");

    // Now PRIVATE: a non-creator admin is 404'd at the view gate, BEFORE any
    // edit logic — so the admin can't reach (or flip back) another user's
    // private meeting.
    const adminPatchOnPrivate = await app.inject({ method: "PATCH", url: `/api/meeting/${id}`,
      headers: { cookie: authCookie("admin") }, payload: { visibility: "public", title: "偷改" } });
    expect(adminPatchOnPrivate.statusCode).toBe(404);

    // The creator can still edit their own private meeting.
    const hostPatchOnPrivate = await app.inject({ method: "PATCH", url: `/api/meeting/${id}`,
      headers: { cookie: authCookie("host") }, payload: { title: "主持人改名" } });
    expect(hostPatchOnPrivate.statusCode).toBe(200);
    expect(hostPatchOnPrivate.json().session.title).toBe("主持人改名");
    await app.close();
  });

  it("PATCH 400 on empty body", async () => {
    await seedTrio();
    const app = await buildServer(AUTH);
    const id = (await createPrivate(app)).json().session.id;
    const r = await app.inject({ method: "PATCH", url: `/api/meeting/${id}`, headers: { cookie: authCookie("host") }, payload: {} });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
});
