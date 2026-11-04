import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedRoleAndFolder() {
  const role = await prisma.role.create({ data: { name: "产品" } });
  const mod = await prisma.folder.create({ data: { name: "M", roleId: role.id, visibility: "public" } });
  return { role, mod };
}

describe("POST /api/bookmarks", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("adds a bookmark", async () => {
    const u = await seedAdmin();
    const { mod } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: mod.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/bookmarks", headers: { cookie },
      payload: { articleId: a.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bookmark.userId).toBe(u.id);
    await app.close();
  });

  it("409 on duplicate bookmark", async () => {
    const u = await seedAdmin();
    const { mod } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: mod.roleId } });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/bookmarks", headers: { cookie },
      payload: { articleId: a.id },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("可收藏其他用户创建的文档(去草稿隐私,目录公开可读)", async () => {
    await prisma.user.create({ data: { ssoId: "zs", displayName: "Z" } });
    const author = await prisma.user.create({ data: { ssoId: "author", displayName: "A" } });
    const role = await prisma.role.create({ data: { name: "r" } });
    const mod = await prisma.folder.create({ data: { name: "M", roleId: role.id, visibility: "public" } });
    const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: mod.roleId, createdById: author.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zs");
    const res = await app.inject({
      method: "POST", url: "/api/bookmarks", headers: { cookie },
      payload: { articleId: a.id },
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(res.json().isBookmarked).toBe(true);
    await app.close();
  });
});

describe("DELETE /api/bookmarks/:articleId", () => {
  beforeEach(async () => { await resetDb(); });

  it("removes a bookmark; idempotent and returns fresh count", async () => {
    const u = await seedAdmin();
    const { mod } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: mod.roleId } });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // First DELETE removes the row; second DELETE is a no-op but
    // still returns the (now zero) count so the client can keep its
    // badge in sync without an extra round-trip.
    const r1 = await app.inject({ method: "DELETE", url: `/api/bookmarks/${a.id}`, headers: { cookie } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ isBookmarked: false, bookmarkCount: 0 });
    const r2 = await app.inject({ method: "DELETE", url: `/api/bookmarks/${a.id}`, headers: { cookie } });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ isBookmarked: false, bookmarkCount: 0 });
    await app.close();
  });
});

describe("GET /api/bookmarks", () => {
  beforeEach(async () => { await resetDb(); });

  it("returns bookmarked articles, filtered to canView", async () => {
    const u = await seedAdmin();
    const { mod } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "Visible", contentMarkdown: "x", folderId: mod.id, roleId: mod.roleId } });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/bookmarks", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().bookmarks).toHaveLength(1);
    expect(res.json().bookmarks[0].article.title).toBe("Visible");
    await app.close();
  });

  it("其他用户创建的文档收藏照常返回(去草稿隐私,不再隐藏)", async () => {
    const u = await prisma.user.create({ data: { ssoId: "zs", displayName: "Z" } });
    const author = await prisma.user.create({ data: { ssoId: "author", displayName: "A" } });
    const role = await prisma.role.create({ data: { name: "r" } });
    const mod = await prisma.folder.create({ data: { name: "M", roleId: role.id, visibility: "public" } });
    const a = await prisma.article.create({ data: { title: "Shown", contentMarkdown: "x", folderId: mod.id, roleId: mod.roleId, createdById: author.id } });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zs");
    const res = await app.inject({ method: "GET", url: "/api/bookmarks", headers: { cookie } });
    expect(res.json().bookmarks.map((b: { article: { title: string } }) => b.article.title)).toEqual(["Shown"]);
    await app.close();
  });

  it("list response omits contentMarkdown (kept small even for large bodies)", async () => {
    const u = await seedAdmin();
    const { mod } = await seedRoleAndFolder();
    const bigBody = "L".repeat(500_000);
    const a = await prisma.article.create({ data: { title: "Big", contentMarkdown: bigBody, folderId: mod.id, roleId: mod.roleId } });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/bookmarks", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bookmarks[0].article.contentMarkdown).toBeUndefined();
    expect(res.body.length).toBeLessThan(50_000);
    await app.close();
  });
});
