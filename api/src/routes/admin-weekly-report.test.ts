import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { beijingWeekOf } from "../utils/beijingWeek.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
const json = { "content-type": "application/json" };

describe("周报页放开给所有成员后", () => {
  beforeEach(async () => { await resetDb(); await prisma.weeklyReport.deleteMany(); });
  afterAll(async () => { await disconnectDb(); });

  it("成员能读列表，但不能触发生成（只有管理员可以）", async () => {
    await seedAdmin();
    await seedUser({ ssoId: "member" });
    const app = await buildServer(AUTH);
    await app.inject({
      method: "PATCH", url: "/api/admin/page-visibility",
      headers: { cookie: authCookie("admin"), ...json }, payload: { key: "weekly-report", visibility: "all" },
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/weekly-report", headers: { cookie: authCookie("member") } });
    expect(list.statusCode).toBe(200);

    const gen = await app.inject({ method: "POST", url: "/api/admin/weekly-report/generate", headers: { cookie: authCookie("member") } });
    expect(gen.statusCode).toBe(403);
    const weekKey = beijingWeekOf(new Date()).weekKey;
    expect(await prisma.weeklyReport.count({ where: { weekKey } })).toBe(0);

    const adminGen = await app.inject({ method: "POST", url: "/api/admin/weekly-report/generate", headers: { cookie: authCookie("admin") } });
    expect(adminGen.statusCode).toBe(200);
    expect(await prisma.weeklyReport.count({ where: { weekKey } })).toBe(1);
    await app.close();
  });
});
