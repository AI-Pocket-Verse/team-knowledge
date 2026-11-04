import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("routes/admin-experts", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("GET 默认配置;PATCH 改 instruction + 部分来源开关(合并不重置)", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);

    const g = await app.inject({ method: "GET", url: `/api/admin/roles/${role.id}/expert`, headers: { cookie: authCookie("admin") } });
    expect(g.statusCode).toBe(200);
    expect(g.json().sources).toEqual({ kbDocs: true, crossModule: true, webSearch: false, consult: true });

    const p = await app.inject({
      method: "PATCH", url: `/api/admin/roles/${role.id}/expert`,
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { instruction: "你是产品专家", sources: { webSearch: true } }, // 只改 webSearch
    });
    expect(p.statusCode).toBe(200);
    expect(p.json().instruction).toBe("你是产品专家");
    // 部分更新:webSearch 变 true,其余保持默认(未被重置)。
    expect(p.json().sources).toEqual({ kbDocs: true, crossModule: true, webSearch: true, consult: true });
    await app.close();
  });

  it("PATCH 非法 ownerUserId(不存在)→ 400;清除(null)允许", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);

    const bad = await app.inject({
      method: "PATCH", url: `/api/admin/roles/${role.id}/expert`,
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { ownerUserId: "no-such-user" },
    });
    expect(bad.statusCode).toBe(400);

    const clear = await app.inject({
      method: "PATCH", url: `/api/admin/roles/${role.id}/expert`,
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { ownerUserId: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().ownerUserId).toBeNull();
    await app.close();
  });

  it("非成员非管理员 → 403(GET 与 PATCH)", async () => {
    await seedUser({ ssoId: "ou_u" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const g = await app.inject({ method: "GET", url: `/api/admin/roles/${role.id}/expert`, headers: { cookie: authCookie("ou_u") } });
    expect(g.statusCode).toBe(403);
    const p = await app.inject({ method: "PATCH", url: `/api/admin/roles/${role.id}/expert`, headers: { cookie: authCookie("ou_u"), "content-type": "application/json" }, payload: { enabled: false } });
    expect(p.statusCode).toBe(403);
    await app.close();
  });

  it("角色成员可 GET/PATCH 自己角色;非成员非管理员 → 403", async () => {
    const member = await seedUser({ ssoId: "ou_member" });
    const outsider = await seedUser({ ssoId: "ou_outsider" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: member.id, roleId: role.id } });
    const app = await buildServer(AUTH);

    const g = await app.inject({ method: "GET", url: `/api/admin/roles/${role.id}/expert`, headers: { cookie: authCookie("ou_member") } });
    expect(g.statusCode).toBe(200);
    const p = await app.inject({ method: "PATCH", url: `/api/admin/roles/${role.id}/expert`, headers: { cookie: authCookie("ou_member"), "content-type": "application/json" }, payload: { instruction: "成员改的" } });
    expect(p.statusCode).toBe(200);
    expect(p.json().instruction).toBe("成员改的");

    const blocked = await app.inject({ method: "GET", url: `/api/admin/roles/${role.id}/expert`, headers: { cookie: authCookie("ou_outsider") } });
    expect(blocked.statusCode).toBe(403);
    void outsider;
    await app.close();
  });
});
