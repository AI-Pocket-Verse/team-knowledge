import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function asAdmin() {
  await seedAdmin();
  const app = await buildServer(AUTH);
  const cookie = authCookie("admin");
  return { app, cookie };
}

describe("GET /api/admin/roles", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("rejects non-admin with 403", async () => {
    await prisma.user.create({
      data: { ssoId: "u1", displayName: "U1" },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: { cookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns roles with memberCount for admin", async () => {
    await seedAdmin();
    const r1 = await prisma.role.create({ data: { name: "产品", color: "violet" } });
    const r2 = await prisma.role.create({ data: { name: "设计", color: "pink" } });
    const u1 = await prisma.user.create({
      data: { ssoId: "u1", displayName: "U1" },
    });
    await prisma.userRole.create({ data: { userId: u1.id, roleId: r1.id } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roles).toHaveLength(2);
    expect(body.roles.find((r: { id: string }) => r.id === r1.id).memberCount).toBe(1);
    expect(body.roles.find((r: { id: string }) => r.id === r2.id).memberCount).toBe(0);
    await app.close();
  });

  it("includes folderCount + articleCount (incl. soft-deleted) per role", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品", color: "violet" } });
    const empty = await prisma.role.create({ data: { name: "空角色" } });
    const folder = await prisma.folder.create({ data: { name: "需求", roleId: role.id } });
    // one live article in the folder, one role-direct, one soft-deleted (binned)
    await prisma.article.create({ data: { title: "A1", contentMarkdown: "", roleId: role.id, folderId: folder.id } });
    await prisma.article.create({ data: { title: "A2", contentMarkdown: "", roleId: role.id } });
    await prisma.article.create({ data: { title: "A3", contentMarkdown: "", roleId: role.id, deletedAt: new Date() } });

    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const withContent = body.roles.find((r: { id: string }) => r.id === role.id);
    expect(withContent.folderCount).toBe(1);
    expect(withContent.articleCount).toBe(3); // binned rows count too
    const emptyRole = body.roles.find((r: { id: string }) => r.id === empty.id);
    expect(emptyRole.folderCount).toBe(0);
    expect(emptyRole.articleCount).toBe(0);
    await app.close();
  });
});

describe("POST /api/admin/roles", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a role and returns it with memberCount=0", async () => {
    const { app, cookie } = await asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/roles",
      headers: { cookie },
      payload: { name: "产品", description: "产品需求", color: "violet" },
    });
    expect(res.statusCode).toBe(201);
    const { role } = res.json();
    expect(role).toMatchObject({ name: "产品", description: "产品需求", color: "violet", memberCount: 0 });
    expect(role.id).toBeTruthy();
    await app.close();
  });

  it("returns 409 on duplicate name", async () => {
    await prisma.role.create({ data: { name: "产品" } });
    const { app, cookie } = await asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/roles",
      headers: { cookie },
      payload: { name: "产品" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("conflict");
    await app.close();
  });

  it("returns 400 on invalid color", async () => {
    const { app, cookie } = await asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/roles",
      headers: { cookie },
      payload: { name: "X", color: "not-a-key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("PATCH /api/admin/roles/:id", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("updates name + color", async () => {
    const role = await prisma.role.create({ data: { name: "产品", color: "violet" } });
    const { app, cookie } = await asAdmin();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/roles/${role.id}`,
      headers: { cookie },
      payload: { name: "产品 v2", color: "pink" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toMatchObject({ name: "产品 v2", color: "pink" });
    await app.close();
  });

  it("returns 404 for missing id", async () => {
    const { app, cookie } = await asAdmin();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/roles/nope",
      headers: { cookie },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("DELETE /api/admin/roles/:id", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("deletes the role and cascades UserRole rows", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const user = await prisma.user.create({
      data: { ssoId: "u1", displayName: "U1" },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const { app, cookie } = await asAdmin();
    const res = await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
    expect(await prisma.userRole.findMany({ where: { roleId: role.id } })).toEqual([]);
    await app.close();
  });

  it("blocks deleting a role that still has folders (409) — no cascade purge", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.folder.create({ data: { name: "需求", roleId: role.id } });

    const { app, cookie } = await asAdmin();
    const res = await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("conflict");
    expect(body.folders).toBe(1);
    expect(body.articles).toBe(0);
    // role + folder untouched (no irreversible hard-cascade)
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
    expect(await prisma.folder.count({ where: { roleId: role.id } })).toBe(1);
    await app.close();
  });

  it("blocks deleting a role that only has SOFT-DELETED (binned) content (409)", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    // Already in the recycle bin — role.delete would still hard-purge it.
    await prisma.article.create({
      data: { title: "binned", contentMarkdown: "", roleId: role.id, deletedAt: new Date() },
    });

    const { app, cookie } = await asAdmin();
    const res = await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().articles).toBe(1);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
    await app.close();
  });

  it("deletes an empty role (no folders/articles) → 204", async () => {
    const role = await prisma.role.create({ data: { name: "空角色" } });
    const { app, cookie } = await asAdmin();
    const res = await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
    await app.close();
  });
});
