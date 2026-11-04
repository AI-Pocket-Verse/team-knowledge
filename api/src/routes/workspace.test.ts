import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedUser(ssoId: string, opts: { isAdmin?: boolean } = {}) {
  return prisma.user.create({
    data: {
      ssoId,
      displayName: ssoId.toUpperCase(),
      isAdmin: opts.isAdmin ?? false,
    },
  });
}

async function bindRole(userId: string, roleId: string) {
  await prisma.userRole.create({ data: { userId, roleId } });
}

describe("GET /api/workspace/roles", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("admin sees all roles with 'owned' badge", async () => {
    await seedAdmin();
    await prisma.role.create({ data: { name: "产品" } });
    await prisma.role.create({ data: { name: "设计" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roles).toHaveLength(2);
    expect(body.roles.every((r: { ownership: string }) => r.ownership === "owned")).toBe(true);
    await app.close();
  });

  it("sidebar lists every role: owned first, then all others as readonly", async () => {
    // New product spec: the sidebar is a catalog of every role in the
    // org. Roles the user doesn't belong to and that have no public
    // folders still appear (so users can discover them) — folderCount
    // reflects what they can actually open, which may be 0.
    await seedAdmin();
    const u = await seedUser("zhangsan");
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "设计" } });
    const r3 = await prisma.role.create({ data: { name: "服务端" } });
    await bindRole(u.id, r1.id);
    await prisma.folder.create({ data: { name: "视觉规范", roleId: r2.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "内部RFC", roleId: r3.id, visibility: "private" } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const summary = body.roles.map((r: { name: string; ownership: string; folderCount: number }) =>
      `${r.name}:${r.ownership}:${r.folderCount}`,
    );
    // 产品 = owned (member, 0 folders); 设计 = readonly with 1 folder;
    // 服务端 = readonly with 1 folder — folders are public now, so its
    // (formerly "private") folder counts too.
    expect(summary).toEqual(["产品:owned:0", "设计:readonly:1", "服务端:readonly:1"]);
    await app.close();
  });

  it("user with no roles and no public folders: returns empty list", async () => {
    const u = await seedUser("solo");
    expect(u.isAdmin).toBe(false);
    const app = await buildServer(AUTH);
    const cookie = authCookie("solo");
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual([]);
    await app.close();
  });

  it("folderCount counts ALL folders (every folder is public now)", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    // Folders have no public/private gate, so a non-member sees all 3.
    await prisma.folder.create({ data: { name: "公开 A", roleId: r.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "公开 B", roleId: r.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "私有", roleId: r.id, visibility: "private" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const role = res.json().roles[0];
    expect(role.folderCount).toBe(3);
    expect(role.ownership).toBe("readonly");
    await app.close();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /api/workspace/roles/:roleId/folders", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin (not a role-member): sees BOTH the public and the private folder, both with canEdit=true", async () => {
    // Admins manage everything: they see + edit every folder, public or
    // private, even in roles they don't belong to. (This is what lets an
    // admin who created private folders without joining the role still see
    // their own content.)
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.folder.create({ data: { name: "公开", roleId: r.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "私有", roleId: r.id, visibility: "private" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/workspace/roles/${r.id}/folders`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folders).toHaveLength(2);
    expect(body.folders.map((f: { name: string }) => f.name).sort()).toEqual(["公开", "私有"]);
    expect(body.folders.every((f: { permissions: { canEdit: boolean } }) => f.permissions.canEdit)).toBe(true);
    await app.close();
  });

  it("role owner: all folders with canEdit=true", async () => {
    const u = await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await bindRole(u.id, r.id);
    await prisma.folder.create({ data: { name: "私有", roleId: r.id, visibility: "private" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/workspace/roles/${r.id}/folders`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().folders[0].permissions.canEdit).toBe(true);
    await app.close();
  });

  it("non-owner sees ALL folders (public + private) read-only", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "设计" } });
    await prisma.folder.create({ data: { name: "公开规范", roleId: r.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "私密RFC",  roleId: r.id, visibility: "private" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/workspace/roles/${r.id}/folders`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folders).toHaveLength(2);
    expect(body.folders.map((f: { name: string }) => f.name).sort()).toEqual(["公开规范", "私密RFC"]);
    expect(
      body.folders.every((f: { permissions: { canView: boolean; canEdit: boolean; isReadOnly: boolean } }) =>
        f.permissions.canView && !f.permissions.canEdit && f.permissions.isReadOnly),
    ).toBe(true);
    await app.close();
  });

  it("non-owner of a role with only private folders: sees them read-only (everything is public)", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "服务端" } });
    await prisma.folder.create({ data: { name: "内部", roleId: r.id, visibility: "private" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/workspace/roles/${r.id}/folders`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folders).toHaveLength(1);
    expect(body.folders[0].name).toBe("内部");
    expect(body.folders[0].permissions).toEqual({ canView: true, canEdit: false, isReadOnly: true });
    await app.close();
  });

  it("returns 404 for unknown role id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles/nope/folders", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /api/workspace/folders/:id (detail)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("owner: returns folder with role + createdBy + canEdit=true", async () => {
    const u = await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品", color: "violet" } });
    await bindRole(u.id, r.id);
    const m = await prisma.folder.create({
      data: { name: "需求文档", roleId: r.id, visibility: "private", createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/workspace/folders/${m.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folder.name).toBe("需求文档");
    expect(body.folder.role.name).toBe("产品");
    expect(body.folder.createdBy.displayName).toBe("ZHANGSAN");
    expect(body.folder.permissions.canEdit).toBe(true);
    await app.close();
  });

  it("non-owner, public folder: canView=true, canEdit=false", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "设计" } });
    const m = await prisma.folder.create({
      data: { name: "公开规范", roleId: r.id, visibility: "public" },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/workspace/folders/${m.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.permissions).toEqual({ canView: true, canEdit: false, isReadOnly: true });
    await app.close();
  });

  it("non-owner, private folder: 200 read-only (folders are public now)", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "服务端" } });
    const m = await prisma.folder.create({
      data: { name: "内部", roleId: r.id, visibility: "private" },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "GET", url: `/api/workspace/folders/${m.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.permissions).toEqual({ canView: true, canEdit: false, isReadOnly: true });
    await app.close();
  });

  it("returns 404 for unknown folder id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/workspace/folders/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("createdBy is null when creator was hard-deleted", async () => {
    await seedAdmin();
    const creator = await seedUser("temp");
    const r = await prisma.role.create({ data: { name: "产品" } });
    const m = await prisma.folder.create({
      data: { name: "孤儿目录", roleId: r.id, visibility: "public", createdById: creator.id },
    });
    await prisma.user.delete({ where: { id: creator.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/workspace/folders/${m.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.createdBy).toBeNull();
    await app.close();
  });
});

describe("GET /api/workspace/roles/:roleId/tree — nesting", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("nests subfolders under their top-level folder with their docs", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const top = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "历史", roleId: role.id, parentId: top.id, visibility: "public" } });
    await prisma.article.create({ data: { title: "直属", contentMarkdown: "x", roleId: role.id, folderId: top.id } });
    await prisma.article.create({ data: { title: "子内", contentMarkdown: "y", roleId: role.id, folderId: sub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: `/api/workspace/roles/${role.id}/tree`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folders).toHaveLength(1);             // only the top-level folder at the top
    const topRow = body.folders[0];
    expect(topRow.id).toBe(top.id);
    expect(topRow.parentId).toBeNull();
    expect(topRow.articles).toHaveLength(1);          // direct doc
    expect(topRow.children).toHaveLength(1);          // subfolder
    expect(topRow.children[0].id).toBe(sub.id);
    expect(topRow.children[0].parentId).toBe(top.id);
    expect(topRow.children[0].articles).toHaveLength(1); // doc inside the subfolder
    await app.close();
  });

  it("directArticles 节点带 reviewStatus", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "T", contentMarkdown: "x", roleId: role.id } });
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus" = 'issues' WHERE "id" = ${art.id}`;
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/workspace/roles/${role.id}/tree`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const doc = res.json().directArticles.find((d: { id: string }) => d.id === art.id);
    expect(doc.reviewStatus).toBe("issues");
    await app.close();
  });
});

describe("PATCH /api/workspace/roles/:roleId/pin — 个人置顶", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("多个置顶按【最近置顶在最上】(pinnedAt 倒序)", async () => {
    await seedUser("zhangsan");
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "设计" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const pin = (id: string) => app.inject({ method: "PATCH", url: `/api/workspace/roles/${id}/pin`, headers: { cookie, "content-type": "application/json" }, payload: { pinned: true } });
    await pin(r1.id);
    await new Promise((res) => setTimeout(res, 15)); // 拉开 pinnedAt 先后
    await pin(r2.id);
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    const ids = (res.json().roles as { id: string }[]).map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual([r2.id, r1.id]); // 后置顶的 r2 在最上
    await app.close();
  });

  it("删用户级联清理其个人置顶(User 外键 CASCADE)", async () => {
    const u = await seedUser("zhangsan");
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    await app.inject({ method: "PATCH", url: `/api/workspace/roles/${r1.id}/pin`, headers: { cookie: authCookie("zhangsan"), "content-type": "application/json" }, payload: { pinned: true } });
    expect(await prisma.userRolePin.count({ where: { userId: u.id } })).toBe(1);
    await prisma.user.delete({ where: { id: u.id } });
    expect(await prisma.userRolePin.count({ where: { roleId: r1.id } })).toBe(0); // 不留孤儿置顶
    await app.close();
  });

  it("置顶把角色浮到最顶、pinned=true;取消后回落;每人各自不影响他人", async () => {
    const u = await seedUser("zhangsan");
    const lisi = await seedUser("lisi");
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "设计" } });
    const r3 = await prisma.role.create({ data: { name: "技术" } });
    await bindRole(u.id, r1.id); // 参与「产品」→ owned 靠前
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");

    // 初始:owned(产品)在前,其余按 createdAt。
    const before = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    expect((before.json().roles as { id: string }[]).map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
    expect((before.json().roles as { pinned: boolean }[]).every((r) => !r.pinned)).toBe(true);

    // 置顶只读角色「技术」→ 浮到最顶、pinned=true。
    const pin = await app.inject({ method: "PATCH", url: `/api/workspace/roles/${r3.id}/pin`, headers: { cookie, "content-type": "application/json" }, payload: { pinned: true } });
    expect(pin.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    const rolesAfter = after.json().roles as { id: string; pinned: boolean }[];
    expect(rolesAfter[0]!.id).toBe(r3.id);
    expect(rolesAfter[0]!.pinned).toBe(true);

    // 另一个用户不受影响(各自置顶)。
    const other = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie: authCookie("lisi") } });
    expect((other.json().roles as { pinned: boolean }[]).every((r) => !r.pinned)).toBe(true);
    expect(lisi.id).toBeTruthy();

    // 取消置顶 → 回落到原顺序。
    const unpin = await app.inject({ method: "PATCH", url: `/api/workspace/roles/${r3.id}/pin`, headers: { cookie, "content-type": "application/json" }, payload: { pinned: false } });
    expect(unpin.statusCode).toBe(200);
    const restored = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie } });
    expect((restored.json().roles as { id: string }[]).map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
    await app.close();
  });

  it("pinned 非布尔 → 400;未知角色 → 404", async () => {
    await seedUser("zhangsan");
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    const bad = await app.inject({ method: "PATCH", url: `/api/workspace/roles/${r.id}/pin`, headers: { cookie, "content-type": "application/json" }, payload: {} });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "PATCH", url: "/api/workspace/roles/nope/pin", headers: { cookie, "content-type": "application/json" }, payload: { pinned: true } });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
