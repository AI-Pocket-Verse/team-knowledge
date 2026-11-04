import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { beijingDayKey, startOfBeijingDayMinus } from "../utils/day.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("GET /api/admin/dashboard", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("serves the aggregate overview to a non-admin but hides the per-user table", async () => {
    await seedUser({ ssoId: "u1", isAdmin: false });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard", headers: { cookie: authCookie("u1") } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overview.totalUsers).toBe(1);
    // 个人明细仅管理员可见 — non-admins get the overview with an empty users[].
    expect(body.users).toEqual([]);
    await app.close();
  });

  it("aggregates per-user ops, overview, and recent feed for admin", async () => {
    await seedUser({ ssoId: "admin", displayName: "Admin", isAdmin: true });
    const u = await seedUser({ ssoId: "u1", displayName: "User One" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });

    // Two operations by u1 today: a published doc + a comment on it.
    const art = await prisma.article.create({
      data: { title: "方案", contentMarkdown: "x", roleId: role.id, createdById: u.id },
    });
    await prisma.comment.create({ data: { articleId: art.id, authorId: u.id, body: "hi" } });
    // Mark u1 active today (login/active signal, independent of content ops).
    await prisma.userActiveDay.create({ data: { userId: u.id, day: beijingDayKey(new Date()) } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard?days=14", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.days).toBe(14);
    expect(body.dayLabels).toHaveLength(14);
    expect(body.overview.totalUsers).toBe(2);
    expect(body.overview.docs).toBe(1);
    expect(body.overview.comments).toBe(1);
    // u1 was seeded active today; admin's async stamp may add more.
    expect(body.overview.activeToday).toBeGreaterThanOrEqual(1);

    const row = body.users.find((r: { id: string }) => r.id === u.id);
    expect(row.opsToday).toBe(2); // doc_create + comment
    expect(row.ops7d).toBe(2);
    expect(row.daily[13]).toBe(2); // last bucket = today
    expect(row.roles).toEqual(["产品"]);
    await app.close();
  });

  it("北京 00:30 的操作算北京当天（即使服务器按 UTC 看是前一天）", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const u = await seedUser({ ssoId: "u1", displayName: "User One" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const at = new Date(startOfBeijingDayMinus(new Date(), 0).getTime() + 30 * 60_000); // 北京今天 00:30
    await prisma.article.create({ data: { title: "夜间", contentMarkdown: "x", roleId: role.id, createdById: u.id, createdAt: at } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard?days=7", headers: { cookie: authCookie("admin") } });
    const row = res.json().users.find((r: { id: string }) => r.id === u.id);
    expect(row.daily[6]).toBe(1);
    expect(row.opsToday).toBe(1);
    await app.close();
  });

  it("clamps the days param to [1,60]", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard?days=999", headers: { cookie: authCookie("admin") } });
    expect(res.json().days).toBe(60);
    await app.close();
  });

  it("excludes binned (soft-deleted) docs + their comments from ops counts and overview", async () => {
    await seedUser({ ssoId: "admin", displayName: "Admin", isAdmin: true });
    const u = await seedUser({ ssoId: "u1", displayName: "User One" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });

    // One LIVE doc + comment (counted) and one BINNED doc + its comment
    // (must NOT count toward ops / overview / activity).
    const live = await prisma.article.create({
      data: { title: "活文档", contentMarkdown: "x", roleId: role.id, createdById: u.id },
    });
    await prisma.comment.create({ data: { articleId: live.id, authorId: u.id, body: "live comment" } });
    const binned = await prisma.article.create({
      data: { title: "回收站文档", contentMarkdown: "x", roleId: role.id, createdById: u.id, deletedAt: new Date(), deletedById: u.id },
    });
    await prisma.comment.create({ data: { articleId: binned.id, authorId: u.id, body: "binned comment" } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/dashboard?days=14", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Overview counts only the live doc + live comment.
    expect(body.overview.docs).toBe(1);
    expect(body.overview.comments).toBe(1);
    // Per-user ops: only doc_create(live) + comment(live) = 2.
    const row = body.users.find((r: { id: string }) => r.id === u.id);
    expect(row.opsToday).toBe(2);
    expect(row.ops7d).toBe(2);
    await app.close();
  });

  it("activity feed hides events on binned docs", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const u = await seedUser({ ssoId: "u1", displayName: "User One" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const binned = await prisma.article.create({
      data: { title: "回收站文档", contentMarkdown: "x", roleId: role.id, createdById: u.id, deletedAt: new Date(), deletedById: u.id },
    });
    await prisma.comment.create({ data: { articleId: binned.id, authorId: u.id, body: "binned comment" } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/activity", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    // Nothing surfaces — the only events belong to a binned doc.
    expect(res.json().total).toBe(0);
    await app.close();
  });
});

describe("GET /api/admin/activity", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("serves the global feed to a non-admin but rejects per-user queries", async () => {
    const u1 = await seedUser({ ssoId: "u1", isAdmin: false });
    const app = await buildServer(AUTH);
    // Platform-wide feed (powers the public live stream) → 200 for anyone.
    const globalRes = await app.inject({ method: "GET", url: "/api/admin/activity", headers: { cookie: authCookie("u1") } });
    expect(globalRes.statusCode).toBe(200);
    // A specific user's detailed activity stays admin-only → 403.
    const perUserRes = await app.inject({ method: "GET", url: `/api/admin/activity?userId=${u1.id}`, headers: { cookie: authCookie("u1") } });
    expect(perUserRes.statusCode).toBe(403);
    await app.close();
  });

  it("非管理员拿不到他人自动化名与上传文件名，管理员按 userId 查仍给全名", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    await seedUser({ ssoId: "viewer", isAdmin: false });
    const owner = await seedUser({ ssoId: "owner", displayName: "Owner" });
    await prisma.automation.create({
      data: { userId: owner.id, name: "SECRET-自动化名", prompt: "p", scheduleKind: "interval", scheduleConfig: "{}" },
    });
    await prisma.upload.create({
      data: { filename: "f1.bin", originalName: "SECRET-上传名.xlsx", mimeType: "application/octet-stream", bytes: 1, uploadedById: owner.id },
    });
    const app = await buildServer(AUTH);
    const viewerRes = await app.inject({ method: "GET", url: "/api/admin/activity", headers: { cookie: authCookie("viewer") } });
    const items = viewerRes.json().items as { type: string; title: string | null }[];
    expect(items.map((i) => i.type).sort()).toEqual(["automation_create", "upload"]);
    expect(JSON.stringify(viewerRes.json())).not.toContain("SECRET");
    const adminRes = await app.inject({
      method: "GET", url: `/api/admin/activity?userId=${owner.id}`, headers: { cookie: authCookie("admin") },
    });
    const titles = (adminRes.json().items as { title: string | null }[]).map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(["SECRET-自动化名", "SECRET-上传名.xlsx"]));
    await app.close();
  });

  it("paginates 10 per page and filters by user", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const u1 = await seedUser({ ssoId: "u1", displayName: "User One" });
    const u2 = await seedUser({ ssoId: "u2", displayName: "User Two" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    // 12 ops by u1, 1 by u2.
    for (let i = 0; i < 12; i++) {
      await prisma.article.create({ data: { title: `doc ${i}`, contentMarkdown: "x", roleId: role.id, createdById: u1.id } });
    }
    await prisma.article.create({ data: { title: "other", contentMarkdown: "x", roleId: role.id, createdById: u2.id } });

    const app = await buildServer(AUTH);
    const get = (q: string) => app.inject({ method: "GET", url: `/api/admin/activity${q}`, headers: { cookie: authCookie("admin") } });

    // Global feed: 13 total, first page caps at 10.
    const global1 = (await get("")).json();
    expect(global1.total).toBe(13);
    expect(global1.items).toHaveLength(10);
    expect(global1.page).toBe(1);
    expect(global1.pageSize).toBe(10);
    expect(global1.hasMore).toBe(true);

    // Per-user: u1 has exactly 12; page 1 → 10, page 2 → 2.
    const u1p1 = (await get(`?userId=${u1.id}`)).json();
    expect(u1p1.total).toBe(12);
    expect(u1p1.items).toHaveLength(10);
    expect(u1p1.hasMore).toBe(true);
    expect(u1p1.items.every((it: { userId: string }) => it.userId === u1.id)).toBe(true);

    const u1p2 = (await get(`?userId=${u1.id}&page=2`)).json();
    expect(u1p2.items).toHaveLength(2);
    expect(u1p2.hasMore).toBe(false);
    await app.close();
  });
});
