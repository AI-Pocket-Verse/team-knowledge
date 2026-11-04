import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("/api/admin/assistant-filter", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("requires admin", async () => {
    await seedUser({ ssoId: "u1" });
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "GET", url: "/api/admin/assistant-filter", headers: { cookie: authCookie("u1") } });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it("adds, lists, and removes an exclusion", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "法务" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const add = await app.inject({ method: "POST", url: "/api/admin/assistant-filter", headers: { cookie }, payload: { targetType: "role", targetId: role.id } });
    expect(add.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/admin/assistant-filter", headers: { cookie } });
    expect(list.json().roles).toEqual([{ id: role.id, name: "法务" }]);

    const del = await app.inject({ method: "DELETE", url: "/api/admin/assistant-filter", headers: { cookie }, payload: { targetType: "role", targetId: role.id } });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: "GET", url: "/api/admin/assistant-filter", headers: { cookie } });
    expect(list2.json().roles).toEqual([]);
    await app.close();
  });

  it("rejects an unknown target", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "POST", url: "/api/admin/assistant-filter", headers: { cookie: authCookie("admin") }, payload: { targetType: "role", targetId: "nope" } });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("is idempotent: repeated add keeps one row, delete-of-absent returns 200", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "市场" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    // Adding twice = a single exclusion row (upsert no-op on the 2nd call).
    for (let i = 0; i < 2; i++) {
      const add = await app.inject({ method: "POST", url: "/api/admin/assistant-filter", headers: { cookie }, payload: { targetType: "role", targetId: role.id } });
      expect(add.statusCode).toBe(200);
    }
    expect(await prisma.assistantExclusion.count()).toBe(1);

    // Deleting a target that was never excluded is a no-op 200 (idempotent).
    const delAbsent = await app.inject({ method: "DELETE", url: "/api/admin/assistant-filter", headers: { cookie }, payload: { targetType: "article", targetId: "never-existed" } });
    expect(delAbsent.statusCode).toBe(200);
    expect(await prisma.assistantExclusion.count()).toBe(1);
    await app.close();
  });

  it("round-trips folder + article targets and hides soft-deleted ones from the list", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "研发" } });
    const folder = await prisma.folder.create({ data: { name: "接口文档", roleId: role.id, visibility: "public" } });
    const article = await prisma.article.create({ data: { title: "鉴权说明", contentMarkdown: "x", roleId: role.id, folderId: folder.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    for (const body of [{ targetType: "folder", targetId: folder.id }, { targetType: "article", targetId: article.id }]) {
      const add = await app.inject({ method: "POST", url: "/api/admin/assistant-filter", headers: { cookie }, payload: body });
      expect(add.statusCode).toBe(200);
    }

    const list = await app.inject({ method: "GET", url: "/api/admin/assistant-filter", headers: { cookie } });
    expect(list.json().folders).toEqual([{ id: folder.id, name: "接口文档", roleId: role.id, parentId: null }]);
    expect(list.json().articles).toEqual([{ id: article.id, title: "鉴权说明", roleId: role.id, folderId: folder.id }]);

    // Soft-delete (recycle bin) the article → it must drop from the list even
    // though its exclusion row remains (harmless orphan, not shown).
    await prisma.article.update({ where: { id: article.id }, data: { deletedAt: new Date() } });
    const list2 = await app.inject({ method: "GET", url: "/api/admin/assistant-filter", headers: { cookie } });
    expect(list2.json().articles).toEqual([]);
    expect(await prisma.assistantExclusion.count()).toBe(2); // row still there

    // Cannot newly exclude a soft-deleted target.
    const reAdd = await app.inject({ method: "POST", url: "/api/admin/assistant-filter", headers: { cookie }, payload: { targetType: "article", targetId: article.id } });
    expect(reAdd.statusCode).toBe(404);
    await app.close();
  });
});
