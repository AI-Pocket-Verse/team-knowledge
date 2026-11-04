import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import {
  selectNewEvents, tick, __addTestSubscriber, __setCursorMs, __resetDashboardStream,
} from "./dashboard-stream.js";
import type { ActivityEvent } from "./activity.js";
import type { SseWriter } from "../utils/sse.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

function ev(uid: string | null, atMs: number): ActivityEvent {
  return { id: `e-${atMs}-${Math.random()}`, uid, at: new Date(atMs), type: "doc_create", title: null };
}

afterAll(async () => {
  __resetDashboardStream();
  await disconnectDb();
});

describe("selectNewEvents", () => {
  it("keeps only real-actor events strictly newer than the cursor, ascending", () => {
    const events = [ev("u", 100), ev("u", 300), ev("u", 200), ev(null, 400), ev("u", 50)];
    const out = selectNewEvents(events, 100);
    expect(out.map((e) => e.at.getTime())).toEqual([200, 300]); // >100, sorted asc, null-uid dropped
  });
});

describe("dashboard-stream poller", () => {
  beforeEach(async () => { await resetDb(); __resetDashboardStream(); });

  it("broadcasts new activity + a tick to subscribers", async () => {
    const u = await seedUser({ ssoId: "u1", displayName: "User One" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "新文档", contentMarkdown: "x", roleId: role.id, createdById: u.id } });

    const sent: { event: string; data: unknown }[] = [];
    const fake: SseWriter = { send: (event, data) => sent.push({ event, data }), comment: () => {}, end: () => {} };
    __addTestSubscriber(fake);
    __setCursorMs(0); // everything counts as new

    await tick();

    const activity = sent.find((s) => s.event === "activity");
    expect(activity).toBeTruthy();
    const items = (activity!.data as { items: { title: string | null; userName: string }[] }).items;
    expect(items.some((it) => it.title === "新文档" && it.userName === "User One")).toBe(true);
    expect(sent.some((s) => s.event === "tick")).toBe(true);
  });

  it("自动化名与上传名只推给管理员订阅者，普通订阅者拿到的 title 为空", async () => {
    const u = await seedUser({ ssoId: "u1", displayName: "User One" });
    await prisma.automation.create({
      data: { userId: u.id, name: "SECRET-自动化名", prompt: "p", scheduleKind: "interval", scheduleConfig: "{}" },
    });
    await prisma.upload.create({
      data: { filename: "f1.bin", originalName: "SECRET-上传名.xlsx", mimeType: "application/octet-stream", bytes: 1, uploadedById: u.id },
    });
    const memberSent: { event: string; data: unknown }[] = [];
    const adminSent: { event: string; data: unknown }[] = [];
    __addTestSubscriber({ send: (event, data) => memberSent.push({ event, data }), comment: () => {}, end: () => {} }, false);
    __addTestSubscriber({ send: (event, data) => adminSent.push({ event, data }), comment: () => {}, end: () => {} }, true);
    __setCursorMs(0);

    await tick();

    expect(JSON.stringify(memberSent)).not.toContain("SECRET");
    expect(memberSent.some((s) => s.event === "activity")).toBe(true);
    expect(JSON.stringify(adminSent)).toContain("SECRET-自动化名");
    expect(JSON.stringify(adminSent)).toContain("SECRET-上传名.xlsx");
  });

  it("emits only a tick (no activity) when nothing is newer than the cursor", async () => {
    const sent: { event: string; data: unknown }[] = [];
    __addTestSubscriber({ send: (event, data) => sent.push({ event, data }), comment: () => {}, end: () => {} });
    __setCursorMs(Date.now() + 60_000); // cursor in the future → nothing is newer

    await tick();
    expect(sent.some((s) => s.event === "activity")).toBe(false);
    expect(sent.some((s) => s.event === "tick")).toBe(true);
  });
});

describe("GET /api/admin/dashboard/stream auth", () => {
  beforeEach(async () => { await resetDb(); __resetDashboardStream(); });

  it("401 without a session (stream not opened)", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard/stream" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Non-admins are now allowed to open the stream — the live activity feed is
  // part of the aggregate, publicly-visible dashboard. The remaining pre-hijack
  // guard is the active-account check; a deactivated user is still rejected.
  // (A successful open hijacks the socket and never ends, so it isn't
  // inject-testable here — the poller broadcast is covered above via
  // __addTestSubscriber.)
  it("403 for a deactivated account (stream not opened)", async () => {
    await seedUser({ ssoId: "u1", isAdmin: false, isActive: false });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard/stream", headers: { cookie: authCookie("u1") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
