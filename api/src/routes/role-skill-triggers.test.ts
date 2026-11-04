import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Mock the dispatcher so a trigger doesn't kick a real generation (CLI spawn);
// we only assert that the right mutations mark the role's skill stale.
vi.mock("../services/role-skill/dispatcher.js", () => ({
  kickRoleSkill: vi.fn(async () => {}),
  startRoleSkillDispatcher: vi.fn(),
  QUIET_MS: 300_000,
  MAX_ATTEMPTS: 3,
  MAX_PER_SWEEP: 2,
}));

import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { flushBestEffortWrites } from "../utils/guards.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function adminAndRole() {
  const admin = await seedUser({ ssoId: "admin", isAdmin: true });
  const role = await prisma.role.create({ data: { name: "KB" } });
  return { admin, role };
}
const draft = (roleId: string, createdById: string, title = "T", body = "body") =>
  prisma.article.create({ data: { title, contentMarkdown: body, roleId, createdById } });

describe("role-skill staleness triggers", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("编辑文档内容标记角色技能 stale", async () => {
    // 去状态后:技能源按正文长度纳入,任何内容变更都可能影响技能 → 标记 stale。
    const { admin, role } = await adminAndRole();
    const art = await draft(role.id, admin.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "PATCH", url: `/api/articles/${art.id}`,
      headers: { cookie: authCookie("admin") },
      payload: { contentMarkdown: "改后的正文内容" },
    });
    expect(r.statusCode).toBe(200);
    await flushBestEffortWrites();
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale");
    await app.close();
  });

  it("无实际变更的 PATCH 不触碰角色技能", async () => {
    // 标题/正文均与现值相同 → 不写版本(skipVersion)→ 不标记 stale。
    const { admin, role } = await adminAndRole();
    const art = await draft(role.id, admin.id, "T", "body");
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "PATCH", url: `/api/articles/${art.id}`,
      headers: { cookie: authCookie("admin") },
      payload: { title: "T", contentMarkdown: "body" },
    });
    expect(r.statusCode).toBe(200);
    await flushBestEffortWrites();
    expect(await prisma.roleSkill.findUnique({ where: { roleId: role.id } })).toBeNull();
    await app.close();
  });

  it("deleting a published doc marks the role's skill stale", async () => {
    const { admin, role } = await adminAndRole();
    const pub = await prisma.article.create({
      data: { title: "P", contentMarkdown: "b", roleId: role.id, createdById: admin.id },
    });
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "DELETE", url: `/api/articles/${pub.id}`, headers: { cookie: authCookie("admin") } });
    expect(r.statusCode).toBe(204);
    await flushBestEffortWrites();
    expect((await prisma.roleSkill.findUnique({ where: { roleId: role.id } }))?.status).toBe("stale");
    await app.close();
  });

  it("creating a role seeds a stale skill row", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/admin/roles",
      headers: { cookie: authCookie("admin") },
      payload: { name: "新角色" },
    });
    expect(r.statusCode).toBe(201);
    const roleId = (r.json() as { role: { id: string } }).role.id;
    await flushBestEffortWrites();
    expect((await prisma.roleSkill.findUnique({ where: { roleId } }))?.status).toBe("stale");
    await app.close();
  });

  it("restoring a version of a published doc marks the role's skill stale", async () => {
    const { admin, role } = await adminAndRole();
    const pub = await prisma.article.create({
      data: { title: "Now", contentMarkdown: "now", roleId: role.id, createdById: admin.id },
    });
    const ver = await prisma.articleVersion.create({
      data: { articleId: pub.id, title: "Old", contentMarkdown: "old", authorId: admin.id },
    });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: `/api/articles/${pub.id}/versions/${ver.id}/restore`,
      headers: { cookie: authCookie("admin") },
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    await flushBestEffortWrites();
    expect((await prisma.roleSkill.findUnique({ where: { roleId: role.id } }))?.status).toBe("stale");
    await app.close();
  });
});
