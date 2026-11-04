// GET /api/roles/:roleId/skill 的 currentDocCount 口径:与 hasRetrievableContent 一致,但不全量读正文。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("role skill currentDocCount", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("按可检索正文计数,覆盖边界", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "KB" } });
    const mk = (title: string, contentMarkdown: string, extra: object = {}) =>
      prisma.article.create({ data: { title, contentMarkdown, roleId: role.id, createdById: admin.id, ...extra } });
    await mk("短", "123456789");                            // 9 个可见字符 -> 不计
    await mk("刚好", "1234567890");                         // 10 -> 计
    await mk("只有图", "![a](http://x/y.png) ![b](http://x/z.png)"); // 全被剥离 -> 不计
    await mk("长文前段全是图", "![a](http://x/y.png) ".repeat(200) + "后面才有真正的正文内容"); // 超过前缀仍要读到
    await mk("长文有字", "正文".repeat(800));                // 超长且前缀可见 -> 计
    await mk("已删除", "这是一段足够长的正文内容", { deletedAt: new Date() }); // 回收站 -> 不计
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentDocCount).toBe(3);
    await app.close();
  });
});
