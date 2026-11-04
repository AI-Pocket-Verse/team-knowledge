import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminAnalyticsResponse } from "@team-knowledge/shared";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { beijingDayKey } from "../utils/day.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("GET /api/admin/analytics", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("rejects an unauthenticated request with 401", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/analytics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("serves aggregate analytics to a non-admin", async () => {
    await seedUser({ ssoId: "u1", isAdmin: false });
    const app = await buildServer(AUTH);
    // Trends / composition / rankings are aggregate-only (no per-individual
    // breakdown), so they're part of the publicly-visible dashboard.
    const res = await app.inject({ method: "GET", url: "/api/admin/analytics", headers: { cookie: authCookie("u1") } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("clamps days to [1,60]", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/analytics?days=999", headers: { cookie: authCookie("admin") } });
    expect((res.json() as AdminAnalyticsResponse).days).toBe(60);
    await app.close();
  });

  it("aggregates trends, composition, and rankings for admin", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const u1 = await seedUser({ ssoId: "u1", displayName: "User One" });
    const u2 = await seedUser({ ssoId: "u2", displayName: "User Two" });
    const A = await prisma.role.create({ data: { name: "产品" } });
    const B = await prisma.role.create({ data: { name: "设计" } });

    // A: 2 published + 1 draft (live); B: 1 published; plus 1 binned in A (excluded).
    const a1 = await prisma.article.create({ data: { title: "A1", contentMarkdown: "x", roleId: A.id, createdById: u1.id } });
    const a2 = await prisma.article.create({ data: { title: "A2", contentMarkdown: "x", roleId: A.id, createdById: u1.id } });
    await prisma.article.create({ data: { title: "A3draft", contentMarkdown: "x", roleId: A.id, createdById: u2.id } });
    await prisma.article.create({ data: { title: "B1", contentMarkdown: "x", roleId: B.id, createdById: u2.id } });
    await prisma.article.create({ data: { title: "binned", contentMarkdown: "x", roleId: A.id, createdById: u1.id, deletedAt: new Date(), deletedById: u1.id } });

    // Interactions on live a1.
    await prisma.like.create({ data: { userId: u1.id, articleId: a1.id } });
    await prisma.like.create({ data: { userId: u2.id, articleId: a1.id } });
    await prisma.comment.create({ data: { articleId: a1.id, authorId: u1.id, body: "c" } });
    await prisma.bookmark.create({ data: { userId: u2.id, articleId: a1.id } });

    // Uploads — one of each bucket.
    await prisma.upload.create({ data: { filename: "f1", mimeType: "image/png", bytes: 1, uploadedById: u1.id } });
    await prisma.upload.create({ data: { filename: "f2", mimeType: "application/pdf", bytes: 1, uploadedById: u1.id } });
    await prisma.upload.create({ data: { filename: "f3", mimeType: "application/octet-stream", bytes: 1, uploadedById: u2.id } });

    // Views — a2 hotter than a1.
    await prisma.articleView.create({ data: { articleId: a1.id, userId: u1.id, viewCount: 3 } });
    await prisma.articleView.create({ data: { articleId: a2.id, userId: u1.id, viewCount: 10 } });

    // RoleSkill statuses.
    await prisma.roleSkill.create({ data: { roleId: A.id, status: "fresh" } });
    await prisma.roleSkill.create({ data: { roleId: B.id, status: "failed" } });

    // Active users today.
    await prisma.userActiveDay.create({ data: { userId: u1.id, day: beijingDayKey(new Date()) } });
    await prisma.userActiveDay.create({ data: { userId: u2.id, day: beijingDayKey(new Date()) } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/analytics?days=14", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AdminAnalyticsResponse;
    const last = 13; // today's bucket (days-1)

    expect(body.days).toBe(14);
    expect(body.trends.dayLabels).toHaveLength(14);
    expect(body.trends.docCreate[last]).toBe(4); // 4 live creates today (binned excluded)
    expect(body.trends.comment[last]).toBe(1);
    expect(body.trends.like[last]).toBe(2);
    expect(body.trends.bookmark[last]).toBe(1);
    expect(body.trends.upload[last]).toBe(3);
    expect(body.trends.activeUsers[last]).toBeGreaterThanOrEqual(2); // admin's async stamp may add itself

    const roleCount = (name: string) => body.composition.byRole.find((r) => r.roleName === name)?.count;
    expect(roleCount("产品")).toBe(3);
    expect(roleCount("设计")).toBe(1);
    expect(body.composition.byRole[0].roleName).toBe("产品"); // sorted desc

    const inter = (k: string) => body.composition.byInteraction.find((r) => r.key === k)?.count;
    expect(inter("like")).toBe(2);
    expect(inter("comment")).toBe(1);
    expect(inter("bookmark")).toBe(1);

    const up = (k: string) => body.composition.byUpload.find((r) => r.key === k)?.count;
    expect(up("image")).toBe(1);
    expect(up("document")).toBe(1);
    expect(up("other")).toBe(1);

    // 综合热度(窗口内):a1 有互动 → 1 浏览人 + 2 赞×2 + 1 评论×3 + 1 收藏×2 = 10;
    // a2 仅 1 名浏览者 = 1。故 a1 现在最热(纯浏览量高不再等于「热门」)。
    expect(body.rankings.hotDocs[0].articleId).toBe(a1.id);
    expect(body.rankings.hotDocs[0].score).toBe(10);
    expect(body.rankings.hotDocs[0].likes).toBe(2);
    expect(body.rankings.hotDocs[0].comments).toBe(1);
    expect(body.rankings.hotDocs[0].bookmarks).toBe(1);
    expect(body.rankings.hotDocs.map((d) => d.articleId)).toContain(a2.id);

    expect(body.rankings.docsByRole[0].roleName).toBe("产品");

    const skill = (s: string) => body.rankings.skillStatus.find((r) => r.status === s)?.count;
    expect(skill("fresh")).toBe(1);
    expect(skill("failed")).toBe(1);

    const u1c = body.rankings.topContributors.find((c) => c.userId === u1.id);
    expect(u1c).toBeTruthy();
    await app.close();
  });
});
