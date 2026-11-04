import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("routes/roles", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("GET /api/roles/:id/members 列出该角色成员(姓名/头像)", async () => {
    const caller = await seedUser({ ssoId: "ou_caller" });
    const m1 = await seedUser({ ssoId: "ou_m1", displayName: "成员一" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: m1.id, roleId: role.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/roles/${role.id}/members`, headers: { cookie: authCookie("ou_caller") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([{ userId: m1.id, displayName: "成员一", avatarUrl: null }]);
    void caller;
    await app.close();
  });

  it("未登录 → 401", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/roles/x/members` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
