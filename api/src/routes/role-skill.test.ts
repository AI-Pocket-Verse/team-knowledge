import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Mock the dispatcher so regenerate's kick is a no-op — keeps the test
// deterministic (no real generation racing the assertions / leaking writes).
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
import { computeSourceHash } from "../services/role-skill/source.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function roleWithMember(name: string, userId: string) {
  const role = await prisma.role.create({ data: { name } });
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
  return role;
}

describe("role-skill REST", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("GET → empty status when no skill row exists yet (member)", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("KB", me.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("u1") } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "empty", stale: true, docCount: 0 });
    await app.close();
  });

  it("GET → stored skill for a member", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("KB", me.id);
    await prisma.roleSkill.create({
      data: { roleId: role.id, status: "fresh", content: "---\nname: kb\n---\n\nhi", name: "kb", description: "d", docCount: 2, generatedAt: new Date() },
    });
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("u1") } });
    expect(r.json()).toMatchObject({ status: "fresh", name: "kb", stale: false, docCount: 2 });
    expect((r.json() as { content: string }).content).toContain("hi");
    await app.close();
  });

  it("GET reports the LIVE currentDocCount(按正文长度:有内容计入,空/过短不计入)", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("KB", me.id);
    await prisma.article.create({ data: { title: "P", contentMarkdown: "这是一段足够长的正文内容", roleId: role.id } });
    await prisma.article.create({ data: { title: "S", contentMarkdown: "短", roleId: role.id } });
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("u1") } });
    expect((r.json() as { currentDocCount: number }).currentDocCount).toBe(1);
    await app.close();
  });

  it("GET reports currentDocCount=0 当角色下没有有可检索正文的文档(只有空/过短文档/目录)", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("KB", me.id);
    await prisma.article.create({ data: { title: "S", contentMarkdown: "短", roleId: role.id } });
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("u1") } });
    expect((r.json() as { currentDocCount: number }).currentDocCount).toBe(0);
    await app.close();
  });

  it("404 for a non-member (no existence leak)", async () => {
    await seedUser({ ssoId: "u1" });
    const other = await seedUser({ ssoId: "u2" });
    const role = await roleWithMember("KB", other.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("u1") } });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("admin can access a role they are not a member of", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const owner = await seedUser({ ssoId: "owner" });
    const role = await roleWithMember("KB", owner.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill`, headers: { cookie: authCookie("admin") } });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("regenerate of a failed skill marks stale + resets attempts (sourceHash kept)", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("KB", me.id);
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "failed", content: "x", sourceHash: "h", attempts: 3, generatedAt: new Date() } });
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "POST", url: `/api/roles/${role.id}/skill/regenerate`, headers: { cookie: authCookie("u1") }, payload: {} });
    expect(r.json()).toMatchObject({ ok: true, status: "stale" });
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale");
    expect(rs?.attempts).toBe(0);
    expect(rs?.sourceHash).toBe("h"); // NOT cleared — let generate's hash diff decide
    await app.close();
  });

  it("regenerate is a no-op when already fresh and the sources are unchanged", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("KB", me.id);
    // Stored hash equals what a fresh gen would produce now (role has no published docs).
    const hash = computeSourceHash({ name: role.name, description: role.description, articles: [] });
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "fresh", content: "skill", sourceHash: hash, generatedAt: new Date() } });
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "POST", url: `/api/roles/${role.id}/skill/regenerate`, headers: { cookie: authCookie("u1") }, payload: {} });
    expect(r.json()).toMatchObject({ ok: true, status: "fresh", upToDate: true });
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("fresh"); // untouched — no regeneration scheduled
    await app.close();
  });

  it("404 for a non-member on regenerate AND raw (no existence leak, no IDOR)", async () => {
    await seedUser({ ssoId: "u1" });
    const other = await seedUser({ ssoId: "u2" });
    const role = await roleWithMember("KB", other.id);
    const app = await buildServer(AUTH);
    const reg = await app.inject({ method: "POST", url: `/api/roles/${role.id}/skill/regenerate`, headers: { cookie: authCookie("u1") }, payload: {} });
    expect(reg.statusCode).toBe(404);
    const raw = await app.inject({ url: `/api/roles/${role.id}/skill/raw`, headers: { cookie: authCookie("u1") } });
    expect(raw.statusCode).toBe(404);
    await app.close();
  });

  it("raw?download=1 → markdown attachment", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await roleWithMember("Assistant知识库", me.id);
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "fresh", content: "# hi", name: "kb" } });
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill/raw?download=1`, headers: { cookie: authCookie("u1") } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/markdown");
    expect(String(r.headers["content-disposition"])).toContain("attachment");
    expect(r.body).toContain("# hi");
    await app.close();
  });

  it("401 without a session", async () => {
    const role = await prisma.role.create({ data: { name: "KB" } });
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: `/api/roles/${role.id}/skill` });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("skill-summary lists the member's roles with usable flags (non-member excluded)", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const withSkill = await roleWithMember("产品", me.id);
    const noSkill = await roleWithMember("设计", me.id);
    await prisma.roleSkill.create({ data: { roleId: withSkill.id, status: "fresh", content: "---\nname: pm\n---\n\nbody" } });
    await prisma.roleSkill.create({ data: { roleId: noSkill.id, status: "empty", content: "" } });
    const other = await seedUser({ ssoId: "u2" });
    await roleWithMember("市场", other.id); // u1 is NOT a member → must not appear

    const app = await buildServer(AUTH);
    const r = await app.inject({ url: "/api/roles/skill-summary", headers: { cookie: authCookie("u1") } });
    expect(r.statusCode).toBe(200);
    const skills = (r.json() as { skills: { roleName: string; usable: boolean; status: string }[] }).skills;
    const byName = (n: string) => skills.find((s) => s.roleName === n);
    expect(skills.map((s) => s.roleName).sort()).toEqual(["产品", "设计"]);
    expect(byName("产品")).toMatchObject({ usable: true, status: "fresh" });
    expect(byName("设计")).toMatchObject({ usable: false });
    expect(byName("市场")).toBeUndefined();
    await app.close();
  });

  it("skill-summary: admin sees all roles", async () => {
    await seedUser({ ssoId: "admin", isAdmin: true });
    const owner = await seedUser({ ssoId: "owner" });
    await roleWithMember("产品", owner.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: "/api/roles/skill-summary", headers: { cookie: authCookie("admin") } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { skills: unknown[] }).skills.length).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("skill-summary 401 without a session", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: "/api/roles/skill-summary" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});
