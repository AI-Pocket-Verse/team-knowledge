import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { buildServer } from "../server.js";
import { env } from "../env.js";
import type { FastifyInstance } from "fastify";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { _resetMeetingWsForTests, _hasLiveChannelForTests, shutdownAllMeetings } from "./meeting-ws.js";
import { invalidateProviderCache } from "../services/llm/registry.js";
import { flushBestEffortWrites } from "../utils/guards.js";
import { _resetLifecycleForTests } from "../services/meeting/lifecycle.js";
import { generateMeetingSummary, EMPTY_MEETING_SUMMARY } from "../services/meeting/summary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../scripts/fake-claude.sh");

// SSO whoami is mocked: the sso_session value IS the ssoId. The auth
// plugin's onRequest hook runs on the WS upgrade request too, so a real
// socket connection authenticates exactly like an HTTP request.
const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// One real port → real socket connections. `app.inject` doesn't
// support WS upgrades; we need a listening socket to exercise the
// upgrade handshake end-to-end.
async function startListening(): Promise<{ app: FastifyInstance; port: number; }> {
  const app = await buildServer(AUTH);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  return { app, port: addr.port };
}

// Acting as a user = sending their sso_session cookie (= their ssoId).
// Kept as an async-shaped helper so existing `await loginAndGetCookie`
// call sites need no change; the password arg is ignored under SSO.
async function loginAndGetCookie(
  _app: FastifyInstance,
  ssoId: string,
  _password?: string,
): Promise<string> {
  return authCookie(ssoId);
}

function openWS(port: number, sessionId: string, cookie: string | null): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/api/meeting/${sessionId}/stream`, {
    headers: cookie ? { cookie } : {},
  });
}

interface WaitedClose { code: number; reason: string }

async function waitForFirstEvent(ws: WebSocket, timeoutMs = 3000): Promise<{ event: Record<string, unknown> | null; closed: WaitedClose | null }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ event: null, closed: null }), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(t);
      try { resolve({ event: JSON.parse(data.toString()) as Record<string, unknown>, closed: null }); }
      catch { resolve({ event: null, closed: null }); }
    });
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(t);
      resolve({ event: null, closed: { code, reason: reasonBuf.toString() } });
    });
  });
}

// For early-reject paths the server sends an error frame FIRST,
// then closes — so `close` won the race against `message`. This
// helper waits specifically for the close event after consuming
// any preceding error frames.
async function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<WaitedClose | null> {
  if (ws.readyState === WebSocket.CLOSED) return { code: 0, reason: "" };
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(t);
      resolve({ code, reason: reasonBuf.toString() });
    });
  });
}

async function waitForEventOfType(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const evt = JSON.parse(data.toString()) as Record<string, unknown>;
        if (evt.type === type) {
          clearTimeout(t);
          ws.off("message", onMessage);
          resolve(evt);
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.on("message", onMessage);
  });
}

async function waitForOpen(ws: WebSocket, timeoutMs = 3000): Promise<boolean> {
  if (ws.readyState === WebSocket.OPEN) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    ws.once("open", () => { clearTimeout(t); resolve(true); });
    ws.once("close", () => { clearTimeout(t); resolve(false); });
    ws.once("error", () => { clearTimeout(t); resolve(false); });
  });
}

async function seedRoleAndMeeting(
  app: FastifyInstance,
  cookie: string,
  configOverrides: Record<string, unknown> = {},
): Promise<{ roleId: string; meetingId: string }> {
  const role = await prisma.role.create({ data: { name: "产品", color: "#8b5cf6" } });
  const r = await app.inject({
    method: "POST",
    url: "/api/meeting",
    headers: { cookie },
    payload: {
      title: "WS 测试",
      allowedRoleIds: [role.id],
      config: {
        tts: false, recording: true, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true,
        triggerKeyword: true, durationHintHours: 4, style: "neutral",
        ...configOverrides,
      },
    },
  });
  return { roleId: role.id, meetingId: r.json().session.id };
}

describe("/api/meeting/:id/stream WebSocket", () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    await resetDb();
    await _resetMeetingWsForTests();
    _resetLifecycleForTests();
    // assistant speaker invokes the LLM provider. Point at the
    // fake-claude script + reset the registry cache so this test
    // file doesn't inherit a real CLAUDE_BIN from a prior test.
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "根据《支付方案 v2》,V2 是异步回调,30 秒内重试 3 次。";
    invalidateProviderCache();
    const started = await startListening();
    app = started.app;
    port = started.port;
  });
  afterEach(async () => {
    await _resetMeetingWsForTests();
    _resetLifecycleForTests();
    await app.close();
  });
  afterAll(async () => { await disconnectDb(); });

  it("rejects upgrade when no session cookie", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    const ws = openWS(port, meetingId, null);
    const closed = await waitForClose(ws);
    expect(closed?.code).toBe(4401);
  });

  it("rejects a cross-site Origin handshake even with a valid session", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/meeting/${meetingId}/stream`, {
      headers: { cookie, origin: "https://evil.example" },
    });
    const closed = await waitForClose(ws);
    expect(closed?.code).toBe(4403);
    expect(closed?.reason).toBe("forbidden_origin");
  });

  it("accepts a handshake whose Origin is WEB_ORIGIN or the site itself", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    for (const origin of [env.WEB_ORIGIN, `http://127.0.0.1:${port}`]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/meeting/${meetingId}/stream`, { headers: { cookie, origin } });
      expect(await waitForOpen(ws)).toBe(true);
      const { event } = await waitForFirstEvent(ws);
      expect(event?.type).toBe("joined");
      ws.close();
      await waitForClose(ws);
    }
  });

  it("rejects upgrade for unknown meeting id", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const ws = openWS(port, "no-such-meeting", cookie);
    const closed = await waitForClose(ws);
    expect(closed?.code).toBe(4404);
  });

  it("rejects upgrade for an already-ended meeting", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // End it via REST first.
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    const ws = openWS(port, meetingId, cookie);
    const closed = await waitForClose(ws);
    expect(closed?.code).toBe(4410);
  });

  it("host gets role=host on joined event", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    const { event } = await waitForFirstEvent(ws);
    expect(event?.type).toBe("joined");
    expect(event?.role).toBe("host");
    expect(event?.hostConnected).toBe(true);
    ws.close();
  });

  it("non-host viewer gets role=viewer + viewerCount updates on join/leave", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "viewer1", displayName: "Viewer1", isAdmin: false });
    const viewerCookie = await loginAndGetCookie(app, "viewer1", "v12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);

    // Host joins first so we can observe the count from its perspective.
    const hostWs = openWS(port, meetingId, adminCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    await waitForEventOfType(hostWs, "joined");

    // Viewer connects → host should see viewer_count change to 1.
    const viewerWs = openWS(port, meetingId, viewerCookie);
    expect(await waitForOpen(viewerWs)).toBe(true);

    const viewerJoined = await waitForEventOfType(viewerWs, "joined");
    expect(viewerJoined?.role).toBe("viewer");

    const countEvt = await waitForEventOfType(hostWs, "viewer_count");
    expect(countEvt?.count).toBe(1);

    // Viewer leaves → count drops back to 0.
    viewerWs.close();
    const countAfterLeave = await waitForEventOfType(hostWs, "viewer_count");
    expect(countAfterLeave?.count).toBe(0);

    hostWs.close();
  });

  it("host_replaced: new host tab evicts the old one", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    const first = openWS(port, meetingId, cookie);
    expect(await waitForOpen(first)).toBe(true);
    await waitForEventOfType(first, "joined");

    const closedPromise = new Promise<WaitedClose>((resolve) => {
      first.once("close", (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }));
    });

    const second = openWS(port, meetingId, cookie);
    expect(await waitForOpen(second)).toBe(true);
    await waitForEventOfType(second, "joined");

    const firstClose = await closedPromise;
    expect(firstClose.code).toBe(4409);
    expect(firstClose.reason).toBe("host_replaced");
    second.close();
  });

  it("host binary chunks get appended to the per-session .wav file", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // Send 3 dummy binary "audio" chunks.
    ws.send(Buffer.from([0xAA, 0xBB]));
    ws.send(Buffer.from([0xCC, 0xDD]));
    ws.send(Buffer.from([0xEE, 0xFF]));

    // End the meeting → server should close the recording stream.
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Verify the row got a recordingUrl pointing at our session.
    const row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(row?.recordingUrl).toBe(`/meeting-recordings/${meetingId}.wav`);

    // Verify the file actually contains the bytes we sent.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { env } = await import("../env.js");
    const buf = readFileSync(resolve(env.DATA_DIR, "meeting-recordings", `${meetingId}.wav`));
    expect(buf.length).toBeGreaterThanOrEqual(6);
    // The bytes should appear in the file in order. Don't assert
    // exact prefix (Append from a previous test run might be there);
    // just check the most recent 6 bytes match the chunks we sent.
    const tail = buf.subarray(buf.length - 6);
    expect(Array.from(tail)).toEqual([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
  });

  it("DELETE meeting broadcasts session_ended + closes both host and viewer", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "viewer1", displayName: "Viewer1", isAdmin: false });
    const viewerCookie = await loginAndGetCookie(app, "viewer1", "v12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);

    const hostWs = openWS(port, meetingId, adminCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    await waitForEventOfType(hostWs, "joined");
    const viewerWs = openWS(port, meetingId, viewerCookie);
    expect(await waitForOpen(viewerWs)).toBe(true);
    await waitForEventOfType(viewerWs, "joined");

    const hostEnded = waitForEventOfType(hostWs, "session_ended");
    const viewerEnded = waitForEventOfType(viewerWs, "session_ended");

    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie: adminCookie } });

    expect(await hostEnded).toBeTruthy();
    expect(await viewerEnded).toBeTruthy();
  });

  // ─── Review fixes ─────────────────────────────────────────────

  it("(CRITICAL-1) deactivated user is rejected even with a valid session cookie", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // Flip the admin to inactive AFTER login. The cookie is still
    // valid but the WS endpoint should reject.
    await prisma.user.updateMany({ where: { ssoId: "admin" }, data: { isActive: false } });

    const ws = openWS(port, meetingId, cookie);
    const closed = await waitForClose(ws);
    expect(closed?.code).toBe(4401);
  });

  it("private meeting live stream rejects a non-creator viewer with 4403", async () => {
    // Host creates a PRIVATE meeting; a stranger who knows the id must be
    // rejected at the visibility gate (4403) — the prior code let any
    // authenticated user join the viewer slot of any active meeting.
    await seedAdmin();
    const hostCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "stranger", displayName: "Stranger", isAdmin: false });
    const strangerCookie = await loginAndGetCookie(app, "stranger", "s12345");
    const role = await prisma.role.create({ data: { name: "产品", color: "#8b5cf6" } });
    const meetingId = (await app.inject({
      method: "POST", url: "/api/meeting", headers: { cookie: hostCookie },
      payload: {
        title: "私密会", allowedRoleIds: [role.id], visibility: "private",
        config: { tts: false, recording: true, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true, triggerKeyword: true, durationHintHours: 4, style: "neutral" },
      },
    })).json().session.id;

    // Stranger (non-creator, non-admin) is rejected.
    const strangerWs = openWS(port, meetingId, strangerCookie);
    const closed = await waitForClose(strangerWs);
    expect(closed?.code).toBe(4403);

    // The creator (host) still joins fine.
    const hostWs = openWS(port, meetingId, hostCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    const joined = await waitForEventOfType(hostWs, "joined");
    expect(joined?.role).toBe("host");
    hostWs.close();
  });

  it("a non-member viewer CAN join a PUBLIC meeting regardless of allowedRoleIds", async () => {
    // allowedRoleIds is an assistant-retrieval scope only, never an access gate:
    // a public meeting scoped to a role the viewer doesn't belong to must
    // still admit them as a read-only viewer.
    await seedAdmin();
    const hostCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "outsider", displayName: "Outsider", isAdmin: false });
    const outsiderCookie = await loginAndGetCookie(app, "outsider", "o12345");
    // Public meeting (default visibility) scoped to a role the outsider lacks.
    const { meetingId } = await seedRoleAndMeeting(app, hostCookie);

    const ws = openWS(port, meetingId, outsiderCookie);
    expect(await waitForOpen(ws)).toBe(true);
    const joined = await waitForEventOfType(ws, "joined");
    expect(joined?.role).toBe("viewer");
    ws.close();
  });

  it("(CRITICAL-2) recording=false: no .wav file written; recordingUrl is null", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie, { recording: false });
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    const joined = await waitForEventOfType(ws, "joined");
    expect(joined?.recordingEnabled).toBe(false);

    // Send chunks anyway → server should drop them silently.
    ws.send(Buffer.from([0xAA, 0xBB]));
    ws.send(Buffer.from([0xCC, 0xDD]));

    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    const row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(row?.recordingUrl).toBeNull();
    // The .wav file must not exist (or be empty if a previous test
    // already touched the dir — checked by absence-of-our-bytes).
    const { existsSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { env } = await import("../env.js");
    const file = resolve(env.DATA_DIR, "meeting-recordings", `${meetingId}.wav`);
    if (existsSync(file)) {
      const buf = readFileSync(file);
      expect(buf.length).toBe(0);
    }
  });

  it("shutdownMeetingChannel is idempotent: double DELETE keeps recordingUrl set", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    ws.send(Buffer.from([0xAA, 0xBB]));
    // First DELETE establishes recordingUrl. Second DELETE must NOT
    // overwrite it with null (the bug HIGH-1 fixed).
    const r1 = await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    const r2 = await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(row?.recordingUrl).toBe(`/meeting-recordings/${meetingId}.wav`);
  });

  it("shutdownAllMeetings tears down live meetings: finalizes recording + flips DB row to ended", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // Send some audio so the recording stream + WAV header exist.
    ws.send(Buffer.from([0x11, 0x22, 0x33, 0x44]));
    await new Promise((r) => setTimeout(r, 30));

    // Sanity: the channel is live + the DB row is still "active" (no DELETE).
    expect(_hasLiveChannelForTests(meetingId)).toBe(true);
    expect((await prisma.meetingSession.findUnique({ where: { id: meetingId } }))?.status).toBe("active");

    // Simulate a SIGTERM teardown: shutdownAllMeetings runs the full per-meeting
    // shutdown (finalize recording + close STT) and flips the row to ended.
    await shutdownAllMeetings();

    // Channel gone; DB row flipped to ended with a recordingUrl.
    expect(_hasLiveChannelForTests(meetingId)).toBe(false);
    const row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(row?.status).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
    expect(row?.recordingUrl).toBe(`/meeting-recordings/${meetingId}.wav`);

    // The WAV header was finalized (RIFF/data sizes patched off 0): the data
    // chunk size at byte 40 must equal fileSize-44 and match our 4 audio bytes.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { env } = await import("../env.js");
    const buf = readFileSync(resolve(env.DATA_DIR, "meeting-recordings", `${meetingId}.wav`));
    const dataLen = buf.readUInt32LE(40);
    expect(dataLen).toBe(buf.length - 44);
    expect(dataLen).toBe(4);
  });

  it("stub STT: 4 host chunks → 1 final transcript persisted + broadcast", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "v1", displayName: "V1", isAdmin: false });
    const viewerCookie = await loginAndGetCookie(app, "v1", "v12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);

    const hostWs = openWS(port, meetingId, adminCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    await waitForEventOfType(hostWs, "joined");
    const viewerWs = openWS(port, meetingId, viewerCookie);
    expect(await waitForOpen(viewerWs)).toBe(true);
    await waitForEventOfType(viewerWs, "joined");

    // Stub provider emits a final every 4 chunks (see stub.ts).
    // Send 4 → viewer should receive exactly 1 transcript_final.
    const finalPromise = waitForEventOfType(viewerWs, "transcript_final");
    for (let i = 0; i < 4; i++) {
      hostWs.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    }
    const finalEvt = await finalPromise;
    expect(finalEvt?.text).toMatch(/chunk#/);
    expect(typeof finalEvt?.id).toBe("string");
    expect(typeof finalEvt?.startMs).toBe("number");
    expect(typeof finalEvt?.endMs).toBe("number");

    // The same final should be persisted to MeetingTranscript.
    // Wait briefly for the async DB insert to commit.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await prisma.meetingTranscript.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.text).toMatch(/chunk#/);

    hostWs.close();
    viewerWs.close();
  });

  it("STT partial events broadcast to viewers (not persisted)", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "v2", displayName: "V2", isAdmin: false });
    const viewerCookie = await loginAndGetCookie(app, "v2", "v12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);

    const hostWs = openWS(port, meetingId, adminCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    await waitForEventOfType(hostWs, "joined");
    const viewerWs = openWS(port, meetingId, viewerCookie);
    expect(await waitForOpen(viewerWs)).toBe(true);
    await waitForEventOfType(viewerWs, "joined");

    const partialPromise = waitForEventOfType(viewerWs, "transcript_partial");
    hostWs.send(Buffer.from([0xAA]));
    const partialEvt = await partialPromise;
    expect(partialEvt?.text).toMatch(/chunk#/);
    expect(typeof partialEvt?.atMs).toBe("number");

    // Partials must NOT be persisted (only finals are).
    await new Promise((r) => setTimeout(r, 30));
    const rows = await prisma.meetingTranscript.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBe(0);

    hostWs.close();
    viewerWs.close();
  });

  it("ending the meeting flushes trailing audio as a final segment", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // Send 2 chunks — below the stub's CHUNKS_PER_FINAL=4 boundary.
    // Without flush-on-close these would be lost. The close path
    // should still persist them as one trailing final.
    ws.send(Buffer.from([0x11]));
    ws.send(Buffer.from([0x22]));
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    const rows = await prisma.meetingTranscript.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toMatch(/chunk#1/);
  });

  it("trailing final is captured + visible to the summary; no transcript persists once shutdown completes", async () => {
    // The fix gates persistAndBroadcastTranscript on `sttClosed` (set only
    // AFTER shutdownMeetingChannel awaits the STT close). Two halves of the
    // contract:
    //   (a) the close()-flushed trailing final still persists (it fires
    //       DURING the awaited close → sttClosed still false) so trailing
    //       audio is NOT lost — and because that happens BEFORE the DELETE
    //       handler's summary read, it lands in the summary (the row is not
    //       silently excluded from a summary that was generated after it).
    //   (b) once shutdown has returned, NO further transcript row materializes
    //       (a genuinely post-shutdown final — e.g. a volc frame arriving after
    //       close() resolved — is dropped, not written after status="ended").
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // Deterministic summary marker so we can prove the LLM summary run actually
    // happened (it only runs the LLM path when transcripts exist — i.e. the
    // trailing final was visible to the summary read).
    process.env.FAKE_CLAUDE_REPLY = "P1_4_SUMMARY_SAW_TRANSCRIPT";
    invalidateProviderCache();

    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // 2 chunks — below the stub's CHUNKS_PER_FINAL=4 boundary, so the ONLY
    // final is the one the close() flush emits during shutdown.
    ws.send(Buffer.from([0x11]));
    ws.send(Buffer.from([0x22]));

    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // (a) trailing final persisted.
    const rows = await prisma.meetingTranscript.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toMatch(/chunk#1/);

    // (b) no late/duplicate row appears after shutdown returned.
    await new Promise((r) => setTimeout(r, 100));
    const rowsAfter = await prisma.meetingTranscript.count({ where: { sessionId: meetingId } });
    expect(rowsAfter).toBe(1);

    // The summary (fire-and-forget after DELETE) took the LLM path because the
    // trailing transcript was present at the summary read — NOT the empty-meeting
    // placeholder. That proves the trailing final wasn't silently excluded.
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBe("P1_4_SUMMARY_SAW_TRANSCRIPT");
    expect(row?.summaryMarkdown).not.toBe(EMPTY_MEETING_SUMMARY);
    ws.close();
  });

  it("recording_stopped event broadcasts to viewers", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "v1", displayName: "V1", isAdmin: false });
    const viewerCookie = await loginAndGetCookie(app, "v1", "v12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);

    const hostWs = openWS(port, meetingId, adminCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    await waitForEventOfType(hostWs, "joined");
    const viewerWs = openWS(port, meetingId, viewerCookie);
    expect(await waitForOpen(viewerWs)).toBe(true);
    await waitForEventOfType(viewerWs, "joined");

    const stopped = waitForEventOfType(viewerWs, "recording_stopped");
    hostWs.send(JSON.stringify({ type: "recording_stopped" }));
    expect(await stopped).toBeTruthy();
    hostWs.close();
    viewerWs.close();
  });

  it("ask_assistant text frame fires speaker → MeetingComment persisted + streaming start/done broadcast", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // Send the manual ask. The speaker will call into the
    // (fake) Claude provider whose canned reply was set in
    // beforeEach. Streaming protocol: start carries the triggerType,
    // done carries the final accumulated text.
    ws.send(JSON.stringify({ type: "ask_assistant", question: "V2 的支付回调是同步还是异步?" }));

    const start = await waitForEventOfType(ws, "assistant_comment_start", 6000);
    expect(start).toBeTruthy();
    expect(start?.triggerType).toBe("user_question");
    expect(typeof start?.id).toBe("string");

    const done = await waitForEventOfType(ws, "assistant_comment_done", 6000);
    expect(done).toBeTruthy();
    expect(done?.id).toBe(start?.id);
    expect(typeof done?.text).toBe("string");
    expect(String(done?.text)).toContain("V2");

    // Verify persistence — give the DB write a beat to commit.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await prisma.meetingComment.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.triggerType).toBe("user_question");
    expect(rows[0]!.text).toContain("V2");

    ws.close();
  });

  it("ask_assistant with empty question is silently ignored (no comment row, no broadcast)", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    ws.send(JSON.stringify({ type: "ask_assistant", question: "   " }));

    // Race a comment vs a short timeout — expect timeout.
    const evt = await waitForEventOfType(ws, "assistant_comment", 800);
    expect(evt).toBeNull();
    const rows = await prisma.meetingComment.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBe(0);
    ws.close();
  });

  it("ask_assistant with an over-length question is rejected (no comment row) and skipped", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // 4097 chars — one past the 4096 cap (mirrors the HTTP chat limit).
    ws.send(JSON.stringify({ type: "ask_assistant", question: "あ".repeat(4097) }));

    const skipped = await waitForEventOfType(ws, "assistant_skipped", 2000);
    expect(skipped).toBeTruthy();
    expect(String(skipped?.reason)).toMatch(/过长/);
    // No generation kicked off → no comment persisted.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await prisma.meetingComment.findMany({ where: { sessionId: meetingId } });
    expect(rows.length).toBe(0);
    ws.close();
  });

  it("DELETE meeting → summary auto-generates + populates summaryMarkdown", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    // Generate a couple of transcript rows so the summary has
    // something to summarize. Use a deterministic FAKE_CLAUDE_REPLY
    // marker so the assertion below proves the LLM call happened
    // (not just that polling-induced placeholders accidentally
    // populated the column).
    process.env.FAKE_CLAUDE_REPLY = "DETERMINISTIC_SUMMARY_MARKER_v1";
    invalidateProviderCache();
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");
    ws.send(Buffer.from([0xAA])); ws.send(Buffer.from([0xBB]));
    ws.send(Buffer.from([0xCC])); ws.send(Buffer.from([0xDD]));
    await waitForEventOfType(ws, "transcript_final");

    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Summary is fire-and-forget; poll briefly for it to land.
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBeTruthy();
    expect(row?.summaryMarkdown).toContain("DETERMINISTIC_SUMMARY_MARKER_v1");
    expect(row?.status).toBe("ended");
    ws.close();
  });

  it("POST /summary force-regenerates: returns the NEW LLM output, not the cached one", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    // Need at least one transcript so the generator takes the LLM
    // path instead of the empty-meeting placeholder shortcut.
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");
    for (let i = 0; i < 4; i++) ws.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    await waitForEventOfType(ws, "transcript_final");

    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Wait for auto-summary to land first.
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    const firstMarkdown = row?.summaryMarkdown ?? "";
    expect(firstMarkdown.length).toBeGreaterThan(0);

    // Swap the fake-claude reply so a real re-run produces different
    // output. If the route returned the cached markdown (the bug
    // CRITICAL #1 fixed), this assertion would catch it.
    process.env.FAKE_CLAUDE_REPLY = "REGENERATED_SUMMARY_CONTENT_v2";
    invalidateProviderCache();

    const r = await app.inject({ method: "POST", url: `/api/meeting/${meetingId}/summary`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().session.summaryMarkdown).toBe("REGENERATED_SUMMARY_CONTENT_v2");
    expect(r.json().session.summaryMarkdown).not.toBe(firstMarkdown);
    ws.close();
  });

  it("summary generator: empty LLM reply persists a failure marker so UI bails out of polling", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    // Send transcript chunks so the generator goes through the LLM
    // path (not the empty-meeting placeholder).
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");
    for (let i = 0; i < 4; i++) ws.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    await waitForEventOfType(ws, "transcript_final");

    // Make the LLM "return empty after trim" before DELETE fires
    // the auto-summary. The fake-claude script defaults to "hi
    // there" when the env var is unset OR empty (`${X:-default}`),
    // so we use whitespace — non-null to avoid the default, trimmed
    // to "" inside summary.ts.
    process.env.FAKE_CLAUDE_REPLY = "   ";
    invalidateProviderCache();

    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Poll for the marker.
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBeTruthy();
    expect(row?.summaryMarkdown).toMatch(/^__MEETING_SUMMARY_FAILED__::/);

    // POST /summary should return 502 + reason when the row holds
    // a failure marker. (Force-regenerate clears it first, but the
    // re-run also produces an empty reply → marker again → 502.)
    const r = await app.inject({ method: "POST", url: `/api/meeting/${meetingId}/summary`, headers: { cookie } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe("summary_failed");
    ws.close();
  });

  it("empty-meeting summary placeholder does NOT block a later regenerate with real material", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);

    // End the meeting with NO audio → summary auto-fires the empty placeholder.
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBe(EMPTY_MEETING_SUMMARY);

    // Now real material appears (e.g. a recording was re-transcribed). A
    // re-run must REPLACE the placeholder instead of short-circuiting on
    // "summary already exists".
    await prisma.meetingTranscript.create({
      data: { sessionId: meetingId, text: "实际转录内容", startMs: 0, endMs: 1000 },
    });
    process.env.FAKE_CLAUDE_REPLY = "REAL_SUMMARY_AFTER_EMPTY_v1";
    invalidateProviderCache();

    const result = await generateMeetingSummary(meetingId, app.log);
    expect(result.summaryMarkdown).toBe("REAL_SUMMARY_AFTER_EMPTY_v1");
    const after = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(after?.summaryMarkdown).toBe("REAL_SUMMARY_AFTER_EMPTY_v1");
    expect(after?.summaryMarkdown).not.toBe(EMPTY_MEETING_SUMMARY);
  });

  it("a REAL summary still short-circuits regenerate (only the empty placeholder is replaceable)", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // Seed an ended meeting that already has a genuine summary.
    await prisma.meetingSession.update({
      where: { id: meetingId },
      data: { status: "ended", endedAt: new Date(), summaryMarkdown: "GENUINE_SUMMARY_v1" },
    });
    await prisma.meetingTranscript.create({
      data: { sessionId: meetingId, text: "内容", startMs: 0, endMs: 1000 },
    });
    process.env.FAKE_CLAUDE_REPLY = "SHOULD_NOT_OVERWRITE";
    invalidateProviderCache();

    const result = await generateMeetingSummary(meetingId, app.log);
    expect(result.reason).toBe("already_generated");
    expect(result.summaryMarkdown).toBe("GENUINE_SUMMARY_v1");
  });

  it("save-as-article is idempotent: double-save returns the same article id", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId, roleId } = await seedRoleAndMeeting(app, cookie);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBeTruthy();

    const r1 = await app.inject({
      method: "POST", url: `/api/meeting/${meetingId}/save-as-article`,
      headers: { cookie }, payload: { roleId },
    });
    const r2 = await app.inject({
      method: "POST", url: `/api/meeting/${meetingId}/save-as-article`,
      headers: { cookie }, payload: { roleId },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().article.id).toBe(r1.json().article.id);

    // Only one article should exist for this meeting in the DB.
    const articles = await prisma.article.findMany({
      where: { contentMarkdown: { contains: `meeting-source:${meetingId}` } },
    });
    expect(articles.length).toBe(1);
  });

  it("save-as-article dedupe is deterministic + anchored: picks earliest marker-prefixed article, ignores mid-body paste", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId, roleId } = await seedRoleAndMeeting(app, cookie);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBeTruthy();

    const marker = `<!-- meeting-source:${meetingId} -->`;
    const admin = await prisma.user.findFirst({ where: { ssoId: "admin" }, select: { id: true } });

    // Two LIVE articles both carrying the marker AS A PREFIX — the scenario the
    // old no-orderBy findFirst made non-deterministic (e.g. a binned saved
    // summary was restored alongside a re-save). The EARLIEST-created one is the
    // canonical idempotent target and must be chosen every time.
    const earliest = await prisma.article.create({
      data: {
        title: "最早纪要", contentMarkdown: `${marker}\n最早内容`,
        roleId, createdById: admin!.id, createdAt: new Date("2020-01-01T00:00:00Z"),
      },
      select: { id: true },
    });
    await prisma.article.create({
      data: {
        title: "较晚纪要", contentMarkdown: `${marker}\n较晚内容`,
        roleId, createdById: admin!.id, createdAt: new Date("2024-01-01T00:00:00Z"),
      },
    });
    // A coincidental paste: an UNRELATED doc that happens to contain the marker
    // string mid-body. The anchored startsWith check must NOT treat it as a hit.
    await prisma.article.create({
      data: {
        title: "无关文档", contentMarkdown: `随手粘贴了一段 ${marker} 在正文中`,
        roleId, createdById: admin!.id, createdAt: new Date("2019-01-01T00:00:00Z"),
      },
    });

    // Two back-to-back saves must BOTH resolve to the earliest marker-prefixed
    // article — deterministic regardless of call order.
    const r1 = await app.inject({
      method: "POST", url: `/api/meeting/${meetingId}/save-as-article`,
      headers: { cookie }, payload: { roleId },
    });
    const r2 = await app.inject({
      method: "POST", url: `/api/meeting/${meetingId}/save-as-article`,
      headers: { cookie }, payload: { roleId },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().article.id).toBe(earliest.id);
    expect(r2.json().article.id).toBe(earliest.id);
  });

  it("GET /meeting-recordings/:filename honors Range requests with 206 + Content-Range", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");
    // Send a chunk so the file has at least 4 bytes.
    ws.send(Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]));
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Range: bytes=0-1 → 206 with 2 bytes.
    const rPartial = await app.inject({
      method: "GET", url: `/api/meeting-recordings/${meetingId}.wav`,
      headers: { cookie, range: "bytes=0-1" },
    });
    expect(rPartial.statusCode).toBe(206);
    expect(rPartial.headers["content-range"]).toMatch(/^bytes 0-1\//);
    expect(rPartial.headers["content-length"]).toBe("2");
    expect(rPartial.rawPayload.length).toBe(2);

    // Out-of-range: should return 416.
    const r416 = await app.inject({
      method: "GET", url: `/api/meeting-recordings/${meetingId}.wav`,
      headers: { cookie, range: "bytes=99999-" },
    });
    expect(r416.statusCode).toBe(416);
    ws.close();
  });

  it("POST /summary rejects when meeting still active", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const r = await app.inject({ method: "POST", url: `/api/meeting/${meetingId}/summary`, headers: { cookie } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("not_ended");
  });

  it("save-as-article creates Article with summary content + meta", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId, roleId } = await seedRoleAndMeeting(app, cookie);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Wait for summary.
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    expect(row?.summaryMarkdown).toBeTruthy();

    const r = await app.inject({
      method: "POST",
      url: `/api/meeting/${meetingId}/save-as-article`,
      headers: { cookie },
      payload: { roleId },
    });
    expect(r.statusCode).toBe(200);
    const articleId = r.json().article.id;
    const article = await prisma.article.findUnique({ where: { id: articleId } });
    expect(article).toBeTruthy();
    expect(article?.contentMarkdown).toContain(row!.summaryMarkdown!);
    expect(article?.contentMarkdown).toContain("AI 会议");
  });

  it("save-as-article 写入的录音链接是可直接访问的绝对地址(站点地址 + /api + 录音路由 + download=1)", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId, roleId } = await seedRoleAndMeeting(app, cookie);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    await prisma.meetingSession.update({ where: { id: meetingId }, data: { recordingUrl: `/meeting-recordings/${meetingId}.wav` } });

    const r = await app.inject({ method: "POST", url: `/api/meeting/${meetingId}/save-as-article`, headers: { cookie }, payload: { roleId } });
    expect(r.statusCode).toBe(200);
    const article = await prisma.article.findUnique({ where: { id: r.json().article.id } });
    const expected = `${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/api/meeting-recordings/${meetingId}.wav?download=1`;
    expect(article?.contentMarkdown).toContain(`> 录音：[下载](${expected})`);
  });

  it("save-as-article 与普通新建一致:建立文档引用、标记角色技能待更新、使用短 id", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId, roleId } = await seedRoleAndMeeting(app, cookie);
    const target = await prisma.article.create({ data: { title: "被引用", contentMarkdown: "x", roleId } });
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    let row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    for (let i = 0; i < 30 && !row?.summaryMarkdown; i++) {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    }
    await prisma.meetingSession.update({ where: { id: meetingId }, data: { summaryMarkdown: `## 决策\n见 [方案](/d/${target.id})` } });

    const r = await app.inject({ method: "POST", url: `/api/meeting/${meetingId}/save-as-article`, headers: { cookie }, payload: { roleId } });
    expect(r.statusCode).toBe(200);
    const saved = r.json().article.id as string;
    await flushBestEffortWrites();
    expect(await prisma.articleReference.count({ where: { fromArticleId: saved, toArticleId: target.id } })).toBe(1);
    expect((await prisma.roleSkill.findUnique({ where: { roleId } }))?.status).toBe("stale");
    expect(saved.length).toBeLessThan(20);
  });

  it("PATCH 改为 private:围观者收到 forbidden 帧并被断开,主持人保留", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    await seedUser({ ssoId: "viewer1", displayName: "Viewer1", isAdmin: false });
    const viewerCookie = await loginAndGetCookie(app, "viewer1", "v12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);

    const hostWs = openWS(port, meetingId, adminCookie);
    expect(await waitForOpen(hostWs)).toBe(true);
    await waitForEventOfType(hostWs, "joined");
    const viewerWs = openWS(port, meetingId, viewerCookie);
    expect(await waitForOpen(viewerWs)).toBe(true);
    await waitForEventOfType(viewerWs, "joined");

    const errP = waitForEventOfType(viewerWs, "error");
    const closeP = waitForClose(viewerWs);
    const zeroCountP = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      hostWs.on("message", (d) => {
        const e = JSON.parse(d.toString()) as Record<string, unknown>;
        if (e.type === "viewer_count" && e.count === 0) { clearTimeout(t); resolve(true); }
      });
    });
    const r = await app.inject({ method: "PATCH", url: `/api/meeting/${meetingId}`, headers: { cookie: adminCookie }, payload: { visibility: "private" } });
    expect(r.statusCode).toBe(200);

    expect((await errP)?.code).toBe("forbidden");
    expect((await closeP)?.code).toBe(4403);
    expect(await zeroCountP).toBe(true);
    expect(hostWs.readyState).toBe(WebSocket.OPEN);
    hostWs.close();
  });

  it("DELETE /:id/hard — soft-deletes an ended meeting into the bin (children kept, hidden from hub/detail)", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // Produce at least one transcript + one assistant comment so we can prove
    // they SURVIVE soft-delete (cascade only fires on permanent-delete).
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");
    for (let i = 0; i < 4; i++) ws.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    await waitForEventOfType(ws, "transcript_final");
    ws.send(JSON.stringify({ type: "comment_now" }));
    await waitForEventOfType(ws, "assistant_comment_done", 6000);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Sanity: row + children exist before soft-delete
    expect(await prisma.meetingSession.findUnique({ where: { id: meetingId } })).toBeTruthy();
    expect((await prisma.meetingTranscript.count({ where: { sessionId: meetingId } }))).toBeGreaterThan(0);
    expect((await prisma.meetingComment.count({ where: { sessionId: meetingId } }))).toBeGreaterThan(0);

    // Soft delete via /hard
    const r = await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}/hard`, headers: { cookie } });
    expect(r.statusCode).toBe(204);

    // Row survives with deletedAt set; children NOT cascaded.
    const after = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(after?.deletedAt).not.toBeNull();
    expect(await prisma.meetingTranscript.count({ where: { sessionId: meetingId } })).toBeGreaterThan(0);
    expect(await prisma.meetingComment.count({ where: { sessionId: meetingId } })).toBeGreaterThan(0);

    // Gone from the hub + 404 from detail.
    const hub = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie } });
    expect((hub.json().recent as { id: string }[]).some((m) => m.id === meetingId)).toBe(false);
    const detail = await app.inject({ method: "GET", url: `/api/meeting/${meetingId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(404);
    ws.close();
  });

  it("DELETE /:id/hard — non-admin host CAN soft-delete their OWN ended meeting", async () => {
    // Permission changed from admin-only to creator-or-admin
    // (canEditMeetingMeta), so a host may bin their own meeting.
    await seedUser({ ssoId: "u1", displayName: "U1", isAdmin: false });
    const userCookie = await loginAndGetCookie(app, "u1", "u12345");
    const { meetingId } = await seedRoleAndMeeting(app, userCookie);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie: userCookie } });

    const r = await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}/hard`, headers: { cookie: userCookie } });
    expect(r.statusCode).toBe(204);
    const after = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedById).toBeTruthy();
  });

  it("DELETE /:id/hard — a stranger (non-creator non-admin) gets 403", async () => {
    await seedAdmin();
    const adminCookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, adminCookie);
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie: adminCookie } });

    // A non-admin who is NOT the creator may not delete it.
    await seedUser({ ssoId: "u1", displayName: "U1", isAdmin: false });
    const userCookie = await loginAndGetCookie(app, "u1", "u12345");
    const r = await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}/hard`, headers: { cookie: userCookie } });
    expect(r.statusCode).toBe(403);
    // Row still live (not binned).
    const after = await prisma.meetingSession.findUnique({ where: { id: meetingId } });
    expect(after?.deletedAt).toBeNull();
  });

  it("DELETE /:id/hard — refuses 400 on still-active meeting", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // Do NOT end it; immediately try to hard-delete
    const r = await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}/hard`, headers: { cookie } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("not_ended");
  });

  it("GET /meeting-recordings/:filename auth gates + 404 on path traversal attempts", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    // Audio chunks → recording file gets written
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");
    ws.send(Buffer.from([0xAA, 0xBB]));
    await app.inject({ method: "DELETE", url: `/api/meeting/${meetingId}`, headers: { cookie } });

    // Unauth → 401
    const r401 = await app.inject({ method: "GET", url: `/api/meeting-recordings/${meetingId}.wav` });
    expect(r401.statusCode).toBe(401);

    // Path traversal attempt
    const rTraversal = await app.inject({ method: "GET", url: "/api/meeting-recordings/..%2Fetc%2Fpasswd", headers: { cookie } });
    expect(rTraversal.statusCode).toBe(404);

    // Wrong session id (file may exist but recordingUrl doesn't match)
    const rWrong = await app.inject({ method: "GET", url: "/api/meeting-recordings/abcdef.wav", headers: { cookie } });
    expect(rWrong.statusCode).toBe(404);

    // Authorized correct fetch → 200 + audio/wav
    const rOk = await app.inject({ method: "GET", url: `/api/meeting-recordings/${meetingId}.wav`, headers: { cookie } });
    expect(rOk.statusCode).toBe(200);
    expect(rOk.headers["content-type"]).toBe("audio/wav");
    ws.close();
  });

  it("per-user cooldown blocks a second ask_assistant within 10s from the same user", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    // First ask — should succeed. Wait for the full done so the busy
    // flag has cleared before the second ask (so the throttle, not the
    // busy gate, is what blocks it).
    ws.send(JSON.stringify({ type: "ask_assistant", question: "V2 上线时间?" }));
    const first = await waitForEventOfType(ws, "assistant_comment_done", 6000);
    expect(first).toBeTruthy();

    // Second ask <10s later — must be throttled with an assistant_skipped
    // carrying the "请等待 Xs" message.
    ws.send(JSON.stringify({ type: "ask_assistant", question: "另一个问题?" }));
    const skipped = await waitForEventOfType(ws, "assistant_skipped", 2000);
    expect(skipped).toBeTruthy();
    expect(String(skipped?.reason)).toContain("请等待");
    ws.close();
  });

  it("host comment_now button fires manual_button trigger", async () => {
    await seedAdmin();
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");
    const { meetingId } = await seedRoleAndMeeting(app, cookie);
    const ws = openWS(port, meetingId, cookie);
    expect(await waitForOpen(ws)).toBe(true);
    await waitForEventOfType(ws, "joined");

    ws.send(JSON.stringify({ type: "comment_now" }));

    const evt = await waitForEventOfType(ws, "assistant_comment_start", 6000);
    expect(evt?.triggerType).toBe("manual_button");
    ws.close();
  });
});

describe("GET /api/meeting/has-active", () => {
  beforeEach(async () => {
    await resetDb();
    await _resetMeetingWsForTests();
    _resetLifecycleForTests();
  });

  it("returns false when no meeting is active; true when one is", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = await loginAndGetCookie(app, "admin", "admin12345");

    const r1 = await app.inject({ method: "GET", url: "/api/meeting/has-active", headers: { cookie } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ hasActive: false });

    const role = await prisma.role.create({ data: { name: "产品", color: null } });
    await app.inject({
      method: "POST", url: "/api/meeting", headers: { cookie },
      payload: {
        title: "x", allowedRoleIds: [role.id],
        config: { tts: false, recording: true, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true, triggerKeyword: true, durationHintHours: 4, style: "neutral" },
      },
    });

    const r2 = await app.inject({ method: "GET", url: "/api/meeting/has-active", headers: { cookie } });
    expect(r2.json()).toEqual({ hasActive: true });
    await app.close();
  });

  it("requires auth", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "GET", url: "/api/meeting/has-active" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});
