import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { setPageVisibility } from "../services/admin-visibility/index.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedUser(ssoId: string) {
  return prisma.user.create({
    data: { ssoId, displayName: ssoId },
  });
}

async function seedRoleAndFolder(opts: { roleName?: string; visibility?: "public" | "private" } = {}) {
  const role = await prisma.role.create({ data: { name: opts.roleName ?? "产品" } });
  const fold = await prisma.folder.create({
    data: { name: "需求池", roleId: role.id, visibility: opts.visibility ?? "public" },
  });
  return { role, fold };
}

// Restore any vi.spyOn (e.g. the bulk-snapshot test spies on the shared
// prisma singleton's findMany) after every test so a leaked one-time mock
// can't bleed into a later test and make it 500 on stale/removed rows.
afterEach(() => { vi.restoreAllMocks(); });

describe("GET /api/folders/:folderId/articles", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("文件夹列表展示全部未删除文档(含他人创建,去草稿隐私)", async () => {
    const author = await seedUser("author");
    await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    await prisma.article.create({ data: { title: "他人文档", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id } });
    await prisma.article.create({ data: { title: "另一篇", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const titles = res.json().articles.map((a: { title: string }) => a.title).sort();
    expect(titles).toEqual(["他人文档", "另一篇"]);
    await app.close();
  });

  it("admin sees their OWN draft (authorship, not the removed admin bypass)", async () => {
    const admin = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    await prisma.article.create({ data: { title: "我的草稿", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: admin.id } });
    await prisma.article.create({ data: { title: "已发布", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const titles = res.json().articles.map((a: { title: string }) => a.title).sort();
    expect(titles).toEqual(["已发布", "我的草稿"]);
    await app.close();
  });

  it("只读访客看到全部未删除文档(去草稿隐私)", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.article.create({ data: { title: "甲", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId } });
    await prisma.article.create({ data: { title: "乙", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId } });
    await prisma.article.create({ data: { title: "丙", contentMarkdown: "z", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const titles = res.json().articles.map((a: { title: string }) => a.title).sort();
    expect(titles).toEqual(["丙", "乙", "甲"]);
    await app.close();
  });

  it("non-member can list a (formerly private) folder's PUBLISHED articles — folders are public now", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "private" });
    await prisma.article.create({ data: { title: "私有", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().articles).toHaveLength(1);
    expect(res.json().articles[0].title).toBe("私有");
    await app.close();
  });

  it("isBookmarked reflects current user's bookmark state", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect(res.json().articles[0].isBookmarked).toBe(true);
    await app.close();
  });

  it("take 限制返回条数(全部可见,按 sortOrder 取前 N)", async () => {
    const author = await seedUser("author");
    await seedUser("viewer");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.article.create({ data: { title: "a1", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id, sortOrder: 0 } });
    await prisma.article.create({ data: { title: "a2", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id, sortOrder: 1 } });
    await prisma.article.create({ data: { title: "a3", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id, sortOrder: 2 } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("viewer");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles?take=2`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const titles = (res.json().articles as { title: string }[]).map((a) => a.title).sort();
    expect(titles).toEqual(["a1", "a2"]);
    await app.close();
  });

  it("author's OWN draft still shows in the listing (query-level filter keeps own drafts)", async () => {
    const author = await seedUser("owner");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.article.create({ data: { title: "我的草稿", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id } });
    await prisma.article.create({ data: { title: "已发布", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: author.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie: authCookie("owner") } });
    expect(res.statusCode).toBe(200);
    const titles = (res.json().articles as { title: string }[]).map((a) => a.title).sort();
    expect(titles).toEqual(["已发布", "我的草稿"]);
    await app.close();
  });

  it("list response omits contentMarkdown (kept small even for large bodies)", async () => {
    await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const bigBody = "L".repeat(500_000); // 500 KB of body that MUST NOT be in the list response
    await prisma.article.create({ data: { title: "大文档", contentMarkdown: bigBody, folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.articles[0].contentMarkdown).toBeUndefined();
    // Sanity: payload shouldn't contain the big body anywhere.
    expect(res.body.length).toBeLessThan(50_000);
    await app.close();
  });
});

describe("GET /api/articles/:id", () => {
  beforeEach(async () => { await resetDb(); });

  it("returns article with folder + role + inboundRefs + versionsCount", async () => {
    const u = await seedAdmin();
    const { role, fold } = await seedRoleAndFolder();
    const target = await prisma.article.create({
      data: { title: "目标", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const citing = await prisma.article.create({
      data: { title: "引用方", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId },
    });
    await prisma.articleReference.create({ data: { fromArticleId: citing.id, toArticleId: target.id } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/articles/${target.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json().article;
    expect(body.title).toBe("目标");
    expect(body.folder.id).toBe(fold.id);
    expect(body.role.id).toBe(role.id);
    expect(body.inboundRefs).toHaveLength(1);
    expect(body.inboundRefs[0].title).toBe("引用方");
    expect(body.versionsCount).toBe(0);
    await app.close();
  });

  it("只读访客(无角色)可查看任意文档(去草稿隐私)—— 只读", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a = await prisma.article.create({
      data: { title: "文档", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.permissions.canEdit).toBe(false);
    expect(res.json().article.permissions.isReadOnly).toBe(true);
    await app.close();
  });

  it("404 for unknown article id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/articles/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /api/articles/:id inboundRefs 含全部未删除引用文档(目录公开可读,去草稿隐私)", async () => {
    // zhangsan has role r1 only
    const zhangsan = await seedUser("zhangsan");
    const r1 = await prisma.role.create({ data: { name: "r1role" } });
    await prisma.userRole.create({ data: { userId: zhangsan.id, roleId: r1.id } });
    const r2 = await prisma.role.create({ data: { name: "r2role" } });

    // Target article in r1 public folder — zhangsan can view
    const f1 = await prisma.folder.create({ data: { name: "F1", roleId: r1.id, visibility: "public" } });
    const target = await prisma.article.create({
      data: { title: "Target", contentMarkdown: "x", folderId: f1.id, roleId: f1.roleId },
    });

    // Citing article A: in r1 public folder — zhangsan can view → should appear
    const citingVisible = await prisma.article.create({
      data: { title: "Visible Ref", contentMarkdown: "y", folderId: f1.id, roleId: f1.roleId },
    });
    await prisma.articleReference.create({ data: { fromArticleId: citingVisible.id, toArticleId: target.id } });

    // Citing article B: another user's doc in a different role/folder. 去草稿
    // 隐私后,目录公开可读 → zhangsan 也能看到它,引用照常出现(不再被过滤)。
    const lisi = await seedUser("lisi");
    const f2 = await prisma.folder.create({ data: { name: "F2", roleId: r2.id, visibility: "private" } });
    const citingOther = await prisma.article.create({
      data: { title: "Other Ref", contentMarkdown: "z", folderId: f2.id, roleId: f2.roleId, createdById: lisi.id },
    });
    await prisma.articleReference.create({ data: { fromArticleId: citingOther.id, toArticleId: target.id } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/articles/${target.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const inboundRefs = res.json().article.inboundRefs as { id: string; title: string }[];
    expect(inboundRefs.map((r) => r.title).sort()).toEqual(["Other Ref", "Visible Ref"]);
    await app.close();
  });

  it("同角色成员可查看(并可编辑)另一用户创建的文档(去草稿隐私)", async () => {
    // Two users both in the same role
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: alice.id, roleId: fold.roleId } });
    await prisma.userRole.create({ data: { userId: bob.id, roleId: fold.roleId } });
    const aliceDoc = await prisma.article.create({
      data: { title: "alice doc", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: alice.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("bob");
    const res = await app.inject({ method: "GET", url: `/api/articles/${aliceDoc.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.permissions.canEdit).toBe(true);
    await app.close();
  });

  it("author can view their own draft even as non-admin", async () => {
    const alice = await seedUser("alice");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: alice.id, roleId: fold.roleId } });
    const draft = await prisma.article.create({
      data: { title: "private draft", contentMarkdown: "secret", folderId: fold.id, roleId: fold.roleId, createdById: alice.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("alice");
    const res = await app.inject({ method: "GET", url: `/api/articles/${draft.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.permissions.canEdit).toBe(true);
    await app.close();
  });
});

describe("POST /api/articles", () => {
  beforeEach(async () => { await resetDb(); });

  it("creates an article successfully", async () => {
    await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/articles", headers: { cookie },
      payload: { folderId: fold.id, roleId: fold.roleId, title: "新", contentMarkdown: "body" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().article.folder.id).toBe(fold.id);
    await app.close();
  });

  it("403 when user has no edit on the folder", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "POST", url: "/api/articles", headers: { cookie },
      payload: { folderId: fold.id, roleId: fold.roleId, title: "X", contentMarkdown: "y" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("404 when folderId doesn't exist (under a real role)", async () => {
    await seedAdmin();
    // Need a real role for the request to clear zod + role-existence
    // gates before hitting the folder-existence check.
    const role = await prisma.role.create({ data: { name: "real-role" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/articles", headers: { cookie },
      payload: { roleId: role.id, folderId: "nope", title: "X", contentMarkdown: "y" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /api/articles/:id", () => {
  beforeEach(async () => { await resetDb(); });

  it("editor can update title + body, snapshot is created", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "old", contentMarkdown: "old body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "new", contentMarkdown: "new body" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.title).toBe("new");
    const versions = await prisma.articleVersion.findMany({ where: { articleId: a.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.title).toBe("new");
    await app.close();
  });

  it("PATCH with unchanged title/body/status skips the version snapshot", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "same", contentMarkdown: "same body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // PATCH with the exact same values
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "same", contentMarkdown: "same body" },
    });
    expect(res.statusCode).toBe(200);
    const versions = await prisma.articleVersion.findMany({ where: { articleId: a.id } });
    expect(versions).toHaveLength(0);
    await app.close();
  });

  it("PATCH with a real change still creates the snapshot (sanity)", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "orig", contentMarkdown: "orig", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { contentMarkdown: "changed" },
    });
    expect(await prisma.articleVersion.count({ where: { articleId: a.id } })).toBe(1);
    await app.close();
  });

  it("历史「已归档」文档现在可以正常编辑(去归档冻结)", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    // 直接写 status 列模拟历史「已归档」数据(该列将在阶段4删除)。
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "frozen body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { contentMarkdown: "现在可以改这段足够长的正文了" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.contentMarkdown).toBe("现在可以改这段足够长的正文了");
    await app.close();
  });

  it("PATCH 携带 status 字段被忽略,不再 400 invalid_transition", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { contentMarkdown: "改个正文内容长一点" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.contentMarkdown).toBe("改个正文内容长一点");
    await app.close();
  });

  it("PATCH rejects with 409 when expectedUpdatedAt is stale (optimistic lock)", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // Simulate another writer landing first by manually bumping updatedAt.
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await prisma.article.update({ where: { id: a.id }, data: { title: "X2" } });
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "user-write", expectedUpdatedAt: a.updatedAt.toISOString() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("conflict");
    // Stale ours, fresh's updatedAt is the canonical one.
    expect(new Date(res.json().serverUpdatedAt).getTime()).toBe(fresh.updatedAt.getTime());
    await app.close();
  });

  it("并发保存携带同一个 expectedUpdatedAt：只有一个成功，另一个 409，版本只多一条", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const send = (body: string) => app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { contentMarkdown: body, expectedUpdatedAt: a.updatedAt.toISOString() },
    });
    const [r1, r2] = await Promise.all([send("from-A"), send("from-B")]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json().error).toBe("conflict");
    const versions = await prisma.articleVersion.count({ where: { articleId: a.id } });
    expect(versions).toBe(1);
    const row = await prisma.article.findUnique({ where: { id: a.id } });
    expect(row!.contentMarkdown).toBe(r1.statusCode === 200 ? "from-A" : "from-B");
    await app.close();
  });

  it("PATCH proceeds when expectedUpdatedAt matches the row", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "new", expectedUpdatedAt: a.updatedAt.toISOString() },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("同角色成员可编辑另一用户创建的文档(去草稿隐私)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: alice.id, roleId: fold.roleId } });
    await prisma.userRole.create({ data: { userId: bob.id, roleId: fold.roleId } });
    const aliceDoc = await prisma.article.create({
      data: { title: "alice doc", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: alice.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("bob");
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${aliceDoc.id}`, headers: { cookie },
      payload: { title: "edited by bob" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("non-editor: 403", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rebuilds ArticleReference rows on save", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const target = await prisma.article.create({
      data: { title: "T", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId },
    });
    const src = await prisma.article.create({
      data: { title: "Src", contentMarkdown: "no refs", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    // Add reference
    await app.inject({
      method: "PATCH", url: `/api/articles/${src.id}`, headers: { cookie },
      payload: { contentMarkdown: `link [t](/r/x/m/y/a/${target.id})` },
    });
    expect(await prisma.articleReference.findMany({ where: { fromArticleId: src.id } })).toHaveLength(1);

    // Remove reference
    await app.inject({
      method: "PATCH", url: `/api/articles/${src.id}`, headers: { cookie },
      payload: { contentMarkdown: "no refs" },
    });
    expect(await prisma.articleReference.findMany({ where: { fromArticleId: src.id } })).toHaveLength(0);
    await app.close();
  });

  it("404 for unknown id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: "/api/articles/nope", headers: { cookie },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH versionsCount matches GET versionsCount after update", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "old", contentMarkdown: "old body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const patchRes = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "new" },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchVersionsCount = patchRes.json().article.versionsCount;

    const getRes = await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie } });
    expect(getRes.statusCode).toBe(200);
    const getVersionsCount = getRes.json().article.versionsCount;

    expect(patchVersionsCount).toBe(getVersionsCount);
    await app.close();
  });
});

describe("DELETE /api/articles/:id", () => {
  beforeEach(async () => { await resetDb(); });

  it("editor can delete: soft-deletes into the bin, keeps versions/refs/bookmarks", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    await prisma.articleVersion.create({ data: { articleId: a.id, title: "X", contentMarkdown: "y" } });
    await prisma.bookmark.create({ data: { userId: u.id, articleId: a.id } });
    const other = await prisma.article.create({
      data: { title: "Other", contentMarkdown: "z", folderId: fold.id, roleId: fold.roleId },
    });
    await prisma.articleReference.create({ data: { fromArticleId: a.id, toArticleId: other.id } });
    await prisma.articleReference.create({ data: { fromArticleId: other.id, toArticleId: a.id } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);

    // Soft-delete: row survives with deletedAt set; the related rows are
    // NOT cascaded (they only drop on permanent-delete from the bin).
    const after = await prisma.article.findUnique({ where: { id: a.id } });
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedById).toBe(u.id);
    expect(await prisma.articleVersion.findMany({ where: { articleId: a.id } })).toHaveLength(1);
    expect(await prisma.bookmark.findMany({ where: { articleId: a.id } })).toHaveLength(1);
    expect(await prisma.articleReference.findMany({ where: { fromArticleId: a.id } })).toHaveLength(1);

    // It's gone from the normal detail surface (treated as not-found).
    const detail = await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(404);
    await app.close();
  });

  it("non-editor: 403", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("404 for unknown id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "DELETE", url: "/api/articles/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/articles/bulk", () => {
  beforeEach(async () => { await resetDb(); });

  // (已删除)bulk publish / archive 用例:去状态后批量操作仅余 delete。

  it("bulk delete: soft-deletes selected articles into the bin", async () => {
    await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "1", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId } });
    const b = await prisma.article.create({ data: { title: "2", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/articles/bulk", headers: { cookie },
      payload: { action: "delete", ids: [a.id, b.id] },
    });
    expect(res.json().ok.sort()).toEqual([a.id, b.id].sort());
    // Rows survive (soft-delete); none remain live.
    expect(await prisma.article.count()).toBe(2);
    expect(await prisma.article.count({ where: { deletedAt: null } })).toBe(0);
    await app.close();
  });

  it("bulk delete: keeps per-id authorization while binning the authorized ids in one batched write", async () => {
    // Perf: the delete branch now soft-deletes via a SINGLE updateMany
    // over the authorized ids (not N sequential updates). The per-id
    // author/admin gate must still hold — a foreign doc the caller can't
    // delete is rejected (forbidden) while the caller's own docs are binned.
    const u = await seedUser("zhangsan");
    const role = await prisma.role.create({ data: { name: "产品" } });
    const fold = await prisma.folder.create({ data: { name: "M1", roleId: role.id, visibility: "public" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const mine1 = await prisma.article.create({ data: { title: "m1", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id } });
    const mine2 = await prisma.article.create({ data: { title: "m2", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id } });
    const foreign = await prisma.article.create({ data: { title: "foreign", contentMarkdown: "y", folderId: fold.id, roleId: role.id } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "POST", url: "/api/articles/bulk", headers: { cookie },
      payload: { action: "delete", ids: [mine1.id, foreign.id, mine2.id] },
    });
    expect(res.json().ok.sort()).toEqual([mine1.id, mine2.id].sort());
    expect(res.json().failed).toHaveLength(1);
    expect(res.json().failed[0].id).toBe(foreign.id);
    expect(res.json().failed[0].reason).toBe("forbidden");

    // The two authorized docs are binned; the foreign doc stays live.
    expect((await prisma.article.findUnique({ where: { id: mine1.id } }))?.deletedAt).not.toBeNull();
    expect((await prisma.article.findUnique({ where: { id: mine2.id } }))?.deletedAt).not.toBeNull();
    expect((await prisma.article.findUnique({ where: { id: foreign.id } }))?.deletedAt).toBeNull();
    await app.close();
  });

  it("non-editor article in selection: that id fails with forbidden", async () => {
    const u = await seedUser("zhangsan");
    const editorRole = await prisma.role.create({ data: { name: "产品" } });
    const editorFold = await prisma.folder.create({ data: { name: "M1", roleId: editorRole.id, visibility: "public" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: editorRole.id } });
    const own = await prisma.article.create({ data: { title: "own", contentMarkdown: "x", folderId: editorFold.id, roleId: editorFold.roleId, createdById: u.id } });

    const otherRole = await prisma.role.create({ data: { name: "设计" } });
    const otherFold = await prisma.folder.create({ data: { name: "M2", roleId: otherRole.id, visibility: "public" } });
    const foreign = await prisma.article.create({ data: { title: "foreign", contentMarkdown: "y", folderId: otherFold.id, roleId: otherFold.roleId } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "POST", url: "/api/articles/bulk", headers: { cookie },
      payload: { action: "delete", ids: [own.id, foreign.id] },
    });
    expect(res.json().ok).toEqual([own.id]);
    expect(res.json().failed[0].id).toBe(foreign.id);
    expect(res.json().failed[0].reason).toBe("forbidden");
    await app.close();
  });
});

describe("GET /api/articles/:id/versions", () => {
  beforeEach(async () => { await resetDb(); });

  it("returns versions desc by createdAt; includes authorDisplayName", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id } });
    await prisma.articleVersion.create({ data: { articleId: a.id, title: "v1", contentMarkdown: "1", authorId: u.id } });
    await new Promise((r) => setTimeout(r, 10));
    await prisma.articleVersion.create({ data: { articleId: a.id, title: "v2", contentMarkdown: "2", authorId: u.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/versions`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const versions = res.json().versions;
    expect(versions.map((v: { title: string }) => v.title)).toEqual(["v2", "v1"]);
    expect(versions[0].authorDisplayName).toBe("Admin");
    await app.close();
  });

  it("任意登录用户可读取版本列表(去草稿隐私,目录公开可读)", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a = await prisma.article.create({ data: { title: "doc", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/versions`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("cursor pagination: take=2 returns page + nextCursor; following pages iterate correctly", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({ data: { title: "P", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: u.id } });
    // Seed 5 versions with distinct timestamps (desc order: v5, v4, v3, v2, v1)
    for (let i = 1; i <= 5; i++) {
      await prisma.articleVersion.create({ data: { articleId: a.id, title: `v${i}`, contentMarkdown: `${i}`, authorId: u.id } });
      if (i < 5) await new Promise((r) => setTimeout(r, 10));
    }
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    // Page 1: take=2 → expect v5, v4; nextCursor = id of v4
    const p1 = await app.inject({ method: "GET", url: `/api/articles/${a.id}/versions?take=2`, headers: { cookie } });
    expect(p1.statusCode).toBe(200);
    const page1 = p1.json();
    expect(page1.versions).toHaveLength(2);
    expect(page1.versions[0].title).toBe("v5");
    expect(page1.versions[1].title).toBe("v4");
    expect(page1.nextCursor).toBe(page1.versions[1].id);

    // Page 2: cursor from page1 → expect v3, v2; nextCursor = id of v2
    const p2 = await app.inject({ method: "GET", url: `/api/articles/${a.id}/versions?take=2&cursor=${page1.nextCursor}`, headers: { cookie } });
    expect(p2.statusCode).toBe(200);
    const page2 = p2.json();
    expect(page2.versions).toHaveLength(2);
    expect(page2.versions[0].title).toBe("v3");
    expect(page2.versions[1].title).toBe("v2");
    expect(page2.nextCursor).toBe(page2.versions[1].id);

    // Page 3: cursor from page2 → expect v1; nextCursor = null
    const p3 = await app.inject({ method: "GET", url: `/api/articles/${a.id}/versions?take=2&cursor=${page2.nextCursor}`, headers: { cookie } });
    expect(p3.statusCode).toBe(200);
    const page3 = p3.json();
    expect(page3.versions).toHaveLength(1);
    expect(page3.versions[0].title).toBe("v1");
    expect(page3.nextCursor).toBeNull();

    await app.close();
  });
});

describe("POST /api/articles/:id/versions/:versionId/restore", () => {
  beforeEach(async () => { await resetDb(); });

  it("restores an older version: content reverts AND pre-restore state is snapshotted", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "v1 title", contentMarkdown: "v1 body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    // Two edits. Each PATCH snapshots the SAVED state as a version (the
    // codebase's version model: every save writes a version row holding
    // that save's values — see the "snapshot is created" test). So after
    // saving v2 then v3 there are two version rows: ["v2", "v3"].
    const e1 = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "v2 title", contentMarkdown: "v2 body" },
    });
    expect(e1.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const e2 = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie },
      payload: { title: "v3 title", contentMarkdown: "v3 body" },
    });
    expect(e2.statusCode).toBe(200);

    const versionsAfterEdits = await prisma.articleVersion.findMany({ where: { articleId: a.id }, orderBy: { createdAt: "asc" } });
    expect(versionsAfterEdits).toHaveLength(2);
    const olderVersion = versionsAfterEdits[0]!; // the v2 save
    expect(olderVersion.title).toBe("v2 title");
    expect(olderVersion.contentMarkdown).toBe("v2 body");

    // Restore the older (v2) version. The live doc is currently v3.
    const res = await app.inject({
      method: "POST", url: `/api/articles/${a.id}/versions/${olderVersion.id}/restore`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    // Article content reverted to v2.
    expect(res.json().article.title).toBe("v2 title");
    expect(res.json().article.contentMarkdown).toBe("v2 body");
    const after = await prisma.article.findUnique({ where: { id: a.id } });
    expect(after?.contentMarkdown).toBe("v2 body");

    // A NEW version row now captures the PRE-restore (v3) state.
    const versionsAfterRestore = await prisma.articleVersion.findMany({ where: { articleId: a.id }, orderBy: { createdAt: "asc" } });
    expect(versionsAfterRestore).toHaveLength(3);
    const preRestore = versionsAfterRestore[2]!;
    expect(preRestore.title).toBe("v3 title");
    expect(preRestore.contentMarkdown).toBe("v3 body");
    await app.close();
  });

  it("404 when versionId belongs to another article", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "A", contentMarkdown: "a", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const b = await prisma.article.create({
      data: { title: "B", contentMarkdown: "b", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const bVersion = await prisma.articleVersion.create({ data: { articleId: b.id, title: "B old", contentMarkdown: "b old", authorId: u.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: `/api/articles/${a.id}/versions/${bVersion.id}/restore`, headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });


  it("403 when caller cannot edit", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId },
    });
    const v = await prisma.articleVersion.create({ data: { articleId: a.id, title: "old", contentMarkdown: "old" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "POST", url: `/api/articles/${a.id}/versions/${v.id}/restore`, headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/articles/:id/views", () => {
  beforeEach(async () => { await resetDb(); });

  it("records a view on detail GET; reports pv + uniqueViewers; author sees viewers", async () => {
    const author = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "看过统计", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id },
    });
    // A second user who can view (published doc, folders are public).
    const reader = await seedUser("reader");

    const app = await buildServer(AUTH);
    // Author opens the doc → records a view. reader opens it → another view.
    expect((await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("admin") } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("reader") } })).statusCode).toBe(200);

    // The view stamp is fire-and-forget; give the microtask queue a beat.
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/views`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pv).toBe(2);
    expect(body.uniqueViewers).toBe(2);
    expect(body.canSeeViewers).toBe(true);
    expect(Array.isArray(body.viewers)).toBe(true);
    const viewerIds = (body.viewers as { user: { id: string } }[]).map((v) => v.user.id).sort();
    expect(viewerIds).toEqual([author.id, reader.id].sort());
    await app.close();
  });

  it("non-author / non-admin gets canSeeViewers:false and viewers:null", async () => {
    const author = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: author.id },
    });
    await seedUser("reader");
    const app = await buildServer(AUTH);
    // reader opens it once to register a view.
    await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("reader") } });
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/views`, headers: { cookie: authCookie("reader") } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pv).toBeGreaterThanOrEqual(1);
    expect(body.uniqueViewers).toBeGreaterThanOrEqual(1);
    expect(body.canSeeViewers).toBe(false);
    expect(body.viewers).toBeNull();
    await app.close();
  });

  it("re-opening within the de-dup window does not inflate pv (single upsert row)", async () => {
    const author = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "去重", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id },
    });
    const app = await buildServer(AUTH);
    // Open three times in quick succession — all inside the 30-min window.
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("admin") } });
      await new Promise((r) => setTimeout(r, 30));
    }
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/views`, headers: { cookie: authCookie("admin") } });
    expect(res.json().pv).toBe(1);
    expect(res.json().uniqueViewers).toBe(1);
    // Exactly one ArticleView row exists (no dropped/duplicate writes).
    expect(await prisma.articleView.count({ where: { articleId: a.id } })).toBe(1);
    await app.close();
  });
});

describe("creator keeps edit/publish without role membership", () => {
  beforeEach(async () => { await resetDb(); });

  it("role-less AUTHOR can edit their OWN doc; still cannot create new in that role", async () => {
    const author = await seedUser("author");           // deliberately NOT a member of `role`
    const { role, fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "原标题", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("author");

    // edit own doc → 200
    const edit = await app.inject({ method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie }, payload: { title: "改后标题" } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().article.title).toBe("改后标题");

    // but CANNOT create a new doc in a role they aren't a member of → 403
    const create = await app.inject({
      method: "POST", url: "/api/articles", headers: { cookie },
      payload: { roleId: role.id, title: "新文档", contentMarkdown: "y" },
    });
    expect(create.statusCode).toBe(403);
    await app.close();
  });

  it("role-less NON-author cannot edit someone else's published doc", async () => {
    const author = await seedUser("author");
    await seedUser("stranger");
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: author.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("stranger") }, payload: { title: "改" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/articles/search", () => {
  beforeEach(async () => { await resetDb(); });

  it("returns matches by title across folders (every published doc is public)", async () => {
    await seedUser("zhangsan");
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const m1 = await prisma.folder.create({ data: { name: "M1", roleId: r1.id, visibility: "public" } });
    const r2 = await prisma.role.create({ data: { name: "私有角色" } });
    const m2 = await prisma.folder.create({ data: { name: "M2", roleId: r2.id, visibility: "private" } });
    await prisma.article.create({ data: { title: "需求文档", contentMarkdown: "x", folderId: m1.id, roleId: m1.roleId } });
    await prisma.article.create({ data: { title: "需求池RFC", contentMarkdown: "y", folderId: m2.id, roleId: m2.roleId } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: "/api/articles/search?q=%E9%9C%80", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // Both published docs match — folder visibility no longer filters search.
    const titles = (res.json().hits.map((h: { title: string }) => h.title) as string[]).sort();
    expect(titles).toEqual(["需求文档", "需求池RFC"].sort());
    await app.close();
  });

  it("400 on missing q", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/articles/search", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // (已删除)「填满整页可引用命中」用例:去状态后 canCite 恒真(目录公开可读),
  // 不再存在「不可引用」命中,该「深翻页越过不可引用行」场景已无法构造。搜索端
  // 的填页逻辑随之成为惰性路径(如需可后续精简,超出本次范围)。

  it("hit 带 updatedAt 与最后修改人(editorName 取最近版本作者,缺省回退创建者)", async () => {
    await seedUser("zhangsan");
    const author = await seedUser("creator");
    const editor = await seedUser("editor");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    // 有版本:editorName 取最近一条带作者的版本。
    const withVer = await prisma.article.create({ data: { title: "需求A", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: author.id } });
    await prisma.articleVersion.create({ data: { articleId: withVer.id, title: "需求A", contentMarkdown: "x", authorId: author.id, createdAt: new Date(Date.now() - 10_000) } });
    await prisma.articleVersion.create({ data: { articleId: withVer.id, title: "需求A", contentMarkdown: "x", authorId: editor.id, createdAt: new Date(Date.now() - 1_000) } });
    // 无版本:回退到创建者。
    const noVer = await prisma.article.create({ data: { title: "需求B", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: author.id } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: "/api/articles/search?q=%E9%9C%80%E6%B1%82", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json().hits as { id: string; updatedAt?: string; editorName?: string | null }[]).map((h) => [h.id, h]));
    expect(byId.get(withVer.id)?.editorName).toBe("editor");
    expect(typeof byId.get(withVer.id)?.updatedAt).toBe("string");
    expect(byId.get(noVer.id)?.editorName).toBe("creator");
    await app.close();
  });
});

describe("GET /api/articles/recent-views", () => {
  beforeEach(async () => { await resetDb(); });

  it("返回本人最近浏览,按 lastViewedAt 倒序,带 shape(lastViewedAt/updatedAt/editorName)", async () => {
    const u = await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a1 = await prisma.article.create({ data: { title: "较早看的", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: u.id } });
    const a2 = await prisma.article.create({ data: { title: "最近看的", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, createdById: u.id } });
    await prisma.articleView.create({ data: { articleId: a1.id, userId: u.id, firstViewedAt: new Date(Date.now() - 60_000), lastViewedAt: new Date(Date.now() - 60_000), viewCount: 1 } });
    await prisma.articleView.create({ data: { articleId: a2.id, userId: u.id, firstViewedAt: new Date(Date.now() - 1_000), lastViewedAt: new Date(Date.now() - 1_000), viewCount: 1 } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: "/api/articles/recent-views", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits as { id: string; title: string; lastViewedAt: string; updatedAt: string; editorName: string | null }[];
    expect(hits.map((h) => h.id)).toEqual([a2.id, a1.id]);
    expect(typeof hits[0]?.lastViewedAt).toBe("string");
    expect(typeof hits[0]?.updatedAt).toBe("string");
    expect(hits[0]).toHaveProperty("editorName");
    await app.close();
  });

  it("排除已删除文档(他人文档去草稿隐私后可见,照常返回)", async () => {
    await seedUser("viewer");
    const other = await seedUser("other");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const me = (await prisma.user.findUnique({ where: { ssoId: "viewer" } }))!;
    const live = await prisma.article.create({ data: { title: "正常", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId } });
    const gone = await prisma.article.create({ data: { title: "已删", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId, deletedAt: new Date() } });
    const othersDoc = await prisma.article.create({ data: { title: "他人文档", contentMarkdown: "z", folderId: fold.id, roleId: fold.roleId, createdById: other.id } });
    for (const a of [live, gone, othersDoc]) {
      await prisma.articleView.create({ data: { articleId: a.id, userId: me.id, firstViewedAt: new Date(), lastViewedAt: new Date(), viewCount: 1 } });
    }

    const app = await buildServer(AUTH);
    const cookie = authCookie("viewer");
    const res = await app.inject({ method: "GET", url: "/api/articles/recent-views", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().hits as { id: string }[]).map((h) => h.id).sort();
    expect(ids).toEqual([live.id, othersDoc.id].sort());
    await app.close();
  });

  it("take 限制返回条数", async () => {
    const u = await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    for (let i = 0; i < 3; i++) {
      const a = await prisma.article.create({ data: { title: `D${i}`, contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: u.id } });
      await prisma.articleView.create({ data: { articleId: a.id, userId: u.id, firstViewedAt: new Date(Date.now() - i * 1000), lastViewedAt: new Date(Date.now() - i * 1000), viewCount: 1 } });
    }
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: "/api/articles/recent-views?take=2", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toHaveLength(2);
    await app.close();
  });
});

describe("GET /api/articles/:id/export", () => {
  beforeEach(async () => { await resetDb(); });

  it("returns text/markdown with YAML frontmatter and Content-Disposition", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "需求文档", contentMarkdown: "# Hello\n\nbody", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=/);
    const body = res.body;
    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/title: "需求文档"/);
    expect(body).toMatch(/\n# Hello\n\nbody$/);
    await app.close();
  });

  it("任意登录用户可导出可见文档(去草稿隐私,目录公开可读)", async () => {
    await seedUser("zhangsan");
    const { fold } = await seedRoleAndFolder({ visibility: "public" });
    const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: fold.roleId } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("collapses newlines in a multi-line title so the YAML front-matter stays one line", async () => {
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    const a = await prisma.article.create({
      data: { title: "第一行\n第二行", contentMarkdown: "body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/export`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // The title is a single quoted scalar with the newline collapsed to a
    // space — it must NOT break the front-matter onto a second line.
    expect(body).toMatch(/title: "第一行 第二行"/);
    await app.close();
  });

  it("returns application/zip with rewritten markdown + assets/ folder when article has uploads", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const JSZip = (await import("jszip")).default;
    const u = await seedAdmin();
    const { fold } = await seedRoleAndFolder();
    // Mirror the prod layout: env.DATA_DIR/uploads/<storage>. Create
    // a real file so buildArticleExport can read its bytes — without
    // a file on disk the export gracefully leaves the URL alone, so
    // we'd be testing the fallback path instead of the bundling
    // path. The DATA_DIR is set to ./data-test by setup-env.ts.
    const uploadDir = path.resolve(process.env.DATA_DIR || "./data-test", "uploads");
    await mkdir(uploadDir, { recursive: true });
    const filename = "abc123def456ghi789jk.pdf";
    const filePath = path.join(uploadDir, filename);
    await writeFile(filePath, Buffer.from("%PDF-1.4\nzip test body"));
    await prisma.upload.create({
      data: {
        id: filename.replace(".pdf", ""),
        filename,
        originalName: "年度报告.pdf",
        mimeType: "application/pdf",
        bytes: 22,
        uploadedById: u.id,
      },
    });
    const a = await prisma.article.create({
      data: {
        title: "带附件的文档",
        contentMarkdown: `看这个文件 [📎 报告](/uploads/${filename})`,
        folderId: fold.id, roleId: fold.roleId,
        createdById: u.id,
      },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(/\.zip"?$/);
    const zip = await JSZip.loadAsync(res.rawPayload);
    // Markdown is at the root of the zip with the article title; the
    // upload URL has been rewritten to a relative ./assets/ path
    // using the user's original filename.
    const mdEntry = zip.file(/\.md$/)[0];
    expect(mdEntry).toBeTruthy();
    const md = await mdEntry!.async("string");
    expect(md).not.toMatch(/\/uploads\//);
    expect(md).toMatch(/\.\/assets\//);
    // Asset bytes are present under assets/, named from originalName.
    const assetEntry = zip.file(/^assets\//)[0];
    expect(assetEntry).toBeTruthy();
    expect(assetEntry!.name).toBe("assets/年度报告.pdf");
    const bytes = await assetEntry!.async("nodebuffer");
    expect(bytes.toString()).toContain("zip test body");
    await app.close();
  });
});

describe("edit-lock /api/articles/:id/edit-lock", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  // Editor (role member) + a second editor, both able to edit a published
  // public-folder doc, so the only thing gating them is the lock itself.
  async function setup() {
    const u1 = await seedUser("u1");
    const u2 = await seedUser("u2");
    const { role, fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: u1.id, roleId: role.id } });
    await prisma.userRole.create({ data: { userId: u2.id, roleId: role.id } });
    const a = await prisma.article.create({
      data: { title: "锁文档", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u1.id },
    });
    const app = await buildServer(AUTH);
    return { app, articleId: a.id, u1, u2 };
  }

  it("acquire → second user 409 → release → second user can acquire", async () => {
    const { app, articleId } = await setup();
    const c1 = authCookie("u1");
    const c2 = authCookie("u2");

    const acq = await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    expect(acq.statusCode).toBe(200);
    const acqBody = acq.json() as { lock: { userId: string; userName: string; mine: boolean; ttlMs: number } };
    expect(acqBody.lock.mine).toBe(true);
    expect(acqBody.lock.ttlMs).toBe(45000);

    // Second user is blocked while u1 holds an active lock.
    const blocked = await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c2 } });
    expect(blocked.statusCode).toBe(409);
    const blockedBody = blocked.json() as { error: string; lock: { mine: boolean; userName: string | null } };
    expect(blockedBody.error).toBe("locked");
    expect(blockedBody.lock.mine).toBe(false);
    expect(blockedBody.lock.userName).toBe("u1");

    // u1 releases (204, idempotent).
    const rel = await app.inject({ method: "DELETE", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    expect(rel.statusCode).toBe(204);

    // Now u2 can acquire.
    const acq2 = await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c2 } });
    expect(acq2.statusCode).toBe(200);
    expect((acq2.json() as { lock: { mine: boolean } }).lock.mine).toBe(true);
    await app.close();
  });

  it("a holder can refresh their own lock (heartbeat) without 409", async () => {
    const { app, articleId } = await setup();
    const c1 = authCookie("u1");
    await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    const refresh = await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    expect(refresh.statusCode).toBe(200);
    expect((refresh.json() as { lock: { mine: boolean } }).lock.mine).toBe(true);
    await app.close();
  });

  it("acquire/heartbeat does NOT bump the doc's updatedAt; a save after a heartbeat still succeeds with the ORIGINAL expectedUpdatedAt", async () => {
    // Regression: the lock used `prisma.article.update`, which bumped
    // @updatedAt. Every 20s heartbeat therefore advanced updatedAt and made
    // the editor's next save 409 against its (now-stale) expectedUpdatedAt.
    // The lock columns are now written via raw UPDATE so they never touch
    // updatedAt — the editor can hold a lock indefinitely and still save.
    const { app, articleId } = await setup();
    const c1 = authCookie("u1");

    const before = (await prisma.article.findUnique({ where: { id: articleId }, select: { updatedAt: true } }))!.updatedAt;
    const expectedUpdatedAt = before.toISOString();

    // Acquire then heartbeat (refresh) — wait between so a stray @updatedAt
    // bump would be observable as a different timestamp.
    await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    await new Promise((r) => setTimeout(r, 10));
    await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });

    const afterLock = (await prisma.article.findUnique({ where: { id: articleId }, select: { updatedAt: true } }))!.updatedAt;
    expect(afterLock.getTime()).toBe(before.getTime());

    // The save uses the ORIGINAL expectedUpdatedAt captured before any
    // heartbeat — it must NOT 409.
    const save = await app.inject({
      method: "PATCH", url: `/api/articles/${articleId}`, headers: { cookie: c1 },
      payload: { contentMarkdown: "edited after heartbeat", expectedUpdatedAt },
    });
    expect(save.statusCode).toBe(200);
    await app.close();
  });

  it("release does NOT bump the doc's updatedAt", async () => {
    // The release path is also a raw UPDATE for the same reason — clearing
    // a lock is not a document edit and must not invalidate a pending save.
    const { app, articleId } = await setup();
    const c1 = authCookie("u1");
    const before = (await prisma.article.findUnique({ where: { id: articleId }, select: { updatedAt: true } }))!.updatedAt;

    await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    await new Promise((r) => setTimeout(r, 10));
    const rel = await app.inject({ method: "DELETE", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: c1 } });
    expect(rel.statusCode).toBe(204);

    const after = (await prisma.article.findUnique({ where: { id: articleId }, select: { updatedAt: true } }))!.updatedAt;
    expect(after.getTime()).toBe(before.getTime());
    await app.close();
  });

  it("a STALE lock (editingAt backdated past TTL) is acquirable by another user", async () => {
    const { app, articleId, u1 } = await setup();
    // Manually plant a stale lock held by u1 (heartbeat older than 45s).
    await prisma.article.update({
      where: { id: articleId },
      data: { editingById: u1.id, editingAt: new Date(Date.now() - 60_000) },
    });
    const acq = await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: authCookie("u2") } });
    expect(acq.statusCode).toBe(200);
    expect((acq.json() as { lock: { mine: boolean } }).lock.mine).toBe(true);
    await app.close();
  });

  it("releasing a lock you don't hold is a no-op 204 and does NOT clear the holder's lock", async () => {
    const { app, articleId } = await setup();
    await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: authCookie("u1") } });
    // u2 releases — should not clear u1's lock.
    const rel = await app.inject({ method: "DELETE", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: authCookie("u2") } });
    expect(rel.statusCode).toBe(204);
    const row = await prisma.article.findUnique({ where: { id: articleId }, select: { editingById: true } });
    expect(row?.editingById).toBe((await prisma.user.findFirst({ where: { ssoId: "u1" } }))?.id);
    await app.close();
  });

  it("a non-editor (not author/collaborator/role-member) gets 403", async () => {
    const outsider = await seedUser("outsider");
    const author = await seedUser("author");
    const { role, fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
    // Draft doc: only author/collaborator can edit; outsider (no role, not
    // author) has no edit permission.
    const a = await prisma.article.create({
      data: { title: "草稿锁", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: author.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: `/api/articles/${a.id}/edit-lock`, headers: { cookie: authCookie("outsider") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("404 for a missing or soft-deleted article", async () => {
    const { app, articleId } = await setup();
    await prisma.article.update({ where: { id: articleId }, data: { deletedAt: new Date() } });
    const res = await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: authCookie("u1") } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("detail GET exposes `editing` only while the lock is active", async () => {
    const { app, articleId, u1 } = await setup();

    // No lock → editing is null.
    const r0 = await app.inject({ method: "GET", url: `/api/articles/${articleId}`, headers: { cookie: authCookie("u2") } });
    expect((r0.json() as { article: { editing: unknown } }).article.editing).toBeNull();

    // Active lock → editing reflects the holder.
    await app.inject({ method: "POST", url: `/api/articles/${articleId}/edit-lock`, headers: { cookie: authCookie("u1") } });
    const r1 = await app.inject({ method: "GET", url: `/api/articles/${articleId}`, headers: { cookie: authCookie("u2") } });
    const editing1 = (r1.json() as { article: { editing: { userId: string; userName: string | null } | null } }).article.editing;
    expect(editing1).not.toBeNull();
    expect(editing1?.userId).toBe(u1.id);
    expect(editing1?.userName).toBe("u1");

    // Backdate the heartbeat past the TTL → editing reads as null again.
    await prisma.article.update({ where: { id: articleId }, data: { editingAt: new Date(Date.now() - 60_000) } });
    const r2 = await app.inject({ method: "GET", url: `/api/articles/${articleId}`, headers: { cookie: authCookie("u2") } });
    expect((r2.json() as { article: { editing: unknown } }).article.editing).toBeNull();
    await app.close();
  });
});

describe("POST /api/articles/reorder — completeness", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("rejects a partial id list (missing a live sibling) with 400 and leaves sortOrder untouched", async () => {
    const u = await seedUser("u");
    const { role, fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const a1 = await prisma.article.create({ data: { title: "A1", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id, sortOrder: 0 } });
    const a2 = await prisma.article.create({ data: { title: "A2", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id, sortOrder: 1 } });
    const a3 = await prisma.article.create({ data: { title: "A3", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id, sortOrder: 2 } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    // Submit only 2 of the 3 live siblings → incomplete → 400.
    const res = await app.inject({
      method: "POST", url: "/api/articles/reorder", headers: { cookie },
      payload: { roleId: role.id, folderId: fold.id, ids: [a2.id, a1.id] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("排序列表不完整");
    // a3's sortOrder is untouched (not corrupted).
    expect((await prisma.article.findUnique({ where: { id: a3.id } }))?.sortOrder).toBe(2);
    await app.close();
  });

  it("accepts the complete id set and rewrites sortOrder to the submitted order", async () => {
    const u = await seedUser("u");
    const { role, fold } = await seedRoleAndFolder({ visibility: "public" });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const a1 = await prisma.article.create({ data: { title: "A1", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id, sortOrder: 0 } });
    const a2 = await prisma.article.create({ data: { title: "A2", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id, sortOrder: 1 } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");
    const res = await app.inject({
      method: "POST", url: "/api/articles/reorder", headers: { cookie },
      payload: { roleId: role.id, folderId: fold.id, ids: [a2.id, a1.id] },
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.article.findUnique({ where: { id: a2.id } }))?.sortOrder).toBe(0);
    expect((await prisma.article.findUnique({ where: { id: a1.id } }))?.sortOrder).toBe(1);
    await app.close();
  });
});

describe("PATCH /api/articles/:id/move — authz", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("an author REMOVED from the doc's role can no longer move it (403)", async () => {
    const author = await seedUser("author");
    const { role, fold } = await seedRoleAndFolder({ visibility: "public" });
    const fold2 = await prisma.folder.create({ data: { name: "另一夹", roleId: role.id, visibility: "public" } });
    // The author created the doc while a member, but is NOT (any longer) a
    // member of the role — no userRole row. Authorship alone must not let
    // them reorganize the role's folder tree.
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: role.id, createdById: author.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}/move`,
      headers: { cookie: authCookie("author"), "content-type": "application/json" },
      payload: { targetFolderId: fold2.id },
    });
    expect(res.statusCode).toBe(403);
    // The doc stayed put.
    expect((await prisma.article.findUnique({ where: { id: a.id } }))?.folderId).toBe(fold.id);
    await app.close();
  });

  it("a current role member can move the doc (200)", async () => {
    const u = await seedUser("member");
    const { role, fold } = await seedRoleAndFolder({ visibility: "public" });
    const fold2 = await prisma.folder.create({ data: { name: "另一夹", roleId: role.id, visibility: "public" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const a = await prisma.article.create({
      data: { title: "X", contentMarkdown: "y", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH", url: `/api/articles/${a.id}/move`,
      headers: { cookie: authCookie("member"), "content-type": "application/json" },
      payload: { targetFolderId: fold2.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().article.folderId).toBe(fold2.id);
    await app.close();
  });
});

describe("GET /api/articles/:id 返回 review 字段", () => {
  beforeEach(async () => { await resetDb(); });

  it("有编辑权限者拿到 reviewStatus + 解析后的 reviewFindings", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "正文", roleId: role.id, createdById: admin.id } });
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus" = 'issues', "reviewFindings" = ${JSON.stringify([{ category: "logic", severity: "high", problem: "P", suggestion: "S", hash: "h1" }])} WHERE "id" = ${art.id}`;
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/articles/${art.id}`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.json().article;
    expect(body.reviewStatus).toBe("issues");
    expect(body.reviewFindings).toHaveLength(1);
    expect(body.reviewFindings[0].problem).toBe("P");
    await app.close();
  });
});

describe("POST /api/articles/:id/review/dismiss", () => {
  beforeEach(async () => { await resetDb(); });

  it("忽略:写入忽略集 + 状态置 dismissed + findings 清空", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "正文", roleId: role.id, createdById: admin.id } });
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus" = 'issues', "reviewFindings" = ${JSON.stringify([{ category: "logic", severity: "high", problem: "P", suggestion: "S", hash: "h1" }])} WHERE "id" = ${art.id}`;
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: `/api/articles/${art.id}/review/dismiss`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const row = (await prisma.article.findUnique({ where: { id: art.id } }))!;
    expect(row.reviewStatus).toBe("dismissed");
    expect(row.reviewFindings).toBeNull();
    await app.close();
  });

  it("无编辑权限 → 403", async () => {
    await seedUser("ou_x");
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "正文", roleId: role.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: `/api/articles/${art.id}/review/dismiss`, headers: { cookie: authCookie("ou_x") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("文档校验页已放开给所有成员 → 只放开查看：无编辑权的成员不能忽略或触发 AI 优化", async () => {
    await seedUser("ou_x");
    await setPageVisibility("article-review", "all", "system");
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "正文", roleId: role.id } });
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus" = 'issues', "reviewFindings" = ${JSON.stringify([{ category: "logic", severity: "high", problem: "P", suggestion: "S", hash: "h1" }])} WHERE "id" = ${art.id}`;
    const app = await buildServer(AUTH);
    const cookie = authCookie("ou_x");
    // 查看仍可用
    expect((await app.inject({ method: "GET", url: "/api/admin/article-review/issues", headers: { cookie } })).statusCode).toBe(200);
    const dismiss = await app.inject({ method: "POST", url: `/api/articles/${art.id}/review/dismiss`, headers: { cookie } });
    expect(dismiss.statusCode).toBe(403);
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.reviewStatus).toBe("issues");
    const optimize = await app.inject({ method: "POST", url: `/api/articles/${art.id}/review/optimize`, headers: { cookie } });
    expect(optimize.statusCode).toBe(403);
    const undismiss = await app.inject({ method: "POST", url: "/api/admin/article-review/undismiss", headers: { cookie }, payload: { articleId: art.id, hash: "h1" } });
    expect(undismiss.statusCode).toBe(403);
    expect(undismiss.json().error).toBe("admin_only");
    await app.close();
  });
});

describe("POST /api/articles/:id/review/optimize", () => {
  beforeEach(async () => { await resetDb(); });

  // 从 SSE 响应体里取某个事件的 data JSON(优化端点已改流式:event: done → { fixedMarkdown })。
  function sseEventData(body: string, event: string): unknown {
    const rec = body.split("\n\n").find((r) => r.includes(`event: ${event}`));
    if (!rec) return null;
    const data = rec.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    try { return JSON.parse(data); } catch { return null; }
  }

  it("无 findings 时直接回原文(不调 LLM)—— SSE done 事件带原文", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "原文内容", roleId: role.id, createdById: admin.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: `/api/articles/${art.id}/review/optimize`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(sseEventData(res.body, "done")).toEqual({ fixedMarkdown: "原文内容" });
    await app.close();
  });

  it("无编辑权限 → 403", async () => {
    await seedUser("ou_x");
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "x", roleId: role.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: `/api/articles/${art.id}/review/optimize`, headers: { cookie: authCookie("ou_x") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/articles/:id/review/apply", () => {
  beforeEach(async () => { await resetDb(); });

  it("应用修订:写 ai-fix 版本 + 更新正文 + bump updatedAt", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "旧正文", roleId: role.id, createdById: admin.id } });
    const before = (await prisma.article.findUnique({ where: { id: art.id } }))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: `/api/articles/${art.id}/review/apply`,
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { contentMarkdown: "新正文(已修订)" },
    });
    expect(res.statusCode).toBe(200);
    const row = (await prisma.article.findUnique({ where: { id: art.id } }))!;
    expect(row.contentMarkdown).toBe("新正文(已修订)");
    expect(row.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    const ver = await prisma.articleVersion.findFirst({ where: { articleId: art.id, kind: "ai-fix" } });
    expect(ver).not.toBeNull();
    expect(ver!.contentMarkdown).toBe("旧正文"); // 版本快照=应用前的原文
    // 一键优化即「标记已优化」:直接置 ok、清空问题(不再立即复检);reviewedHash 对齐到优化后内容。
    expect(res.json().reviewStatus).toBe("ok");
    expect(row.reviewStatus).toBe("ok");
    expect(row.reviewFindings).toBeNull();
    await app.close();
  });

  it("expectedUpdatedAt 过期 → 409(不覆盖他人编辑)", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "旧正文", roleId: role.id, createdById: admin.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: `/api/articles/${art.id}/review/apply`,
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { contentMarkdown: "修订内容", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(409);
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.contentMarkdown).toBe("旧正文"); // 未被覆盖
    await app.close();
  });

  it("文档校验页放开给成员后:无编辑权的成员 apply → 403 且正文不变;有编辑权的成员 apply 成功", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const other = await prisma.role.create({ data: { name: "运营" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "旧正文", roleId: role.id, createdById: admin.id } });
    const outsider = await seedUser("outsider");
    const insider = await seedUser("insider");
    await prisma.userRole.create({ data: { userId: outsider.id, roleId: other.id } });
    await prisma.userRole.create({ data: { userId: insider.id, roleId: role.id } });
    await setPageVisibility("article-review", "all", admin.id);
    const app = await buildServer(AUTH);
    const apply = (ssoId: string, contentMarkdown: string) => app.inject({
      method: "POST", url: `/api/articles/${art.id}/review/apply`,
      headers: { cookie: authCookie(ssoId), "content-type": "application/json" },
      payload: { contentMarkdown },
    });
    const denied = await apply("outsider", "被覆盖的内容");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("forbidden");
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.contentMarkdown).toBe("旧正文");
    const ok = await apply("insider", "角色成员的修订");
    expect(ok.statusCode).toBe(200);
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.contentMarkdown).toBe("角色成员的修订");
    await app.close();
  });
});
