import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedUser(ssoId: string) {
  return prisma.user.create({ data: { ssoId, displayName: ssoId } });
}

describe("页面可见性配置 + admin-access", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("GET/PATCH page-visibility 仅管理员;非白名单 key 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const g = await app.inject({ method: "GET", url: "/api/admin/page-visibility", headers: { cookie: authCookie("admin") } });
    expect(g.statusCode).toBe(200);
    expect(g.json().pages.map((p: { key: string }) => p.key)).toEqual(["article-review", "group-qa", "weekly-report", "web-notify"]);
    const ok = await app.inject({ method: "PATCH", url: "/api/admin/page-visibility", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { key: "group-qa", visibility: "all" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pages.find((p: { key: string }) => p.key === "group-qa").visibility).toBe("all");
    const bad = await app.inject({ method: "PATCH", url: "/api/admin/page-visibility", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { key: "users", visibility: "all" } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("非管理员 GET page-visibility → 403", async () => {
    await seedUser("ou_u");
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/page-visibility", headers: { cookie: authCookie("ou_u") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("me/admin-access:管理员 isAdmin=true;普通用户随放开变化", async () => {
    await seedAdmin();
    await seedUser("ou_u");
    const app = await buildServer(AUTH);
    const a = await app.inject({ method: "GET", url: "/api/me/admin-access", headers: { cookie: authCookie("admin") } });
    expect(a.json()).toMatchObject({ isAdmin: true });
    const u1 = await app.inject({ method: "GET", url: "/api/me/admin-access", headers: { cookie: authCookie("ou_u") } });
    expect(u1.json()).toEqual({ isAdmin: false, openPages: [] });
    await app.inject({ method: "PATCH", url: "/api/admin/page-visibility", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { key: "article-review", visibility: "all" } });
    const u2 = await app.inject({ method: "GET", url: "/api/me/admin-access", headers: { cookie: authCookie("ou_u") } });
    expect(u2.json().openPages).toEqual(["article-review"]);
    await app.close();
  });

  it("放开后普通用户可访问该页接口,改回则 403", async () => {
    await seedAdmin();
    await seedUser("ou_u");
    const app = await buildServer(AUTH);
    const r1 = await app.inject({ method: "GET", url: "/api/admin/group-qa/stats", headers: { cookie: authCookie("ou_u") } });
    expect(r1.statusCode).toBe(403);
    await app.inject({ method: "PATCH", url: "/api/admin/page-visibility", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { key: "group-qa", visibility: "all" } });
    const r2 = await app.inject({ method: "GET", url: "/api/admin/group-qa/stats", headers: { cookie: authCookie("ou_u") } });
    expect(r2.statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: "/api/admin/page-visibility", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { key: "group-qa", visibility: "admin" } });
    const r3 = await app.inject({ method: "GET", url: "/api/admin/group-qa/stats", headers: { cookie: authCookie("ou_u") } });
    expect(r3.statusCode).toBe(403);
    await app.close();
  });
});

describe("放开给全员的后台页：成员只读，敏感标识脱敏", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("群答疑记录：成员看不到群 chat_id 与发言人 open_id，管理员照常", async () => {
    const { recordAnswer, recordLike } = await import("../services/group-qa/store.js");
    const { setPageVisibility } = await import("../services/admin-visibility/index.js");
    await seedAdmin();
    await seedUser("ou_member");
    await setPageVisibility("group-qa", "all", "system");
    await recordAnswer({ chatId: "oc_test_chat", chatName: "测试群", question: "怎么请假", sourceTitle: "请假流程", hash: "h1", at: Date.now() });
    await recordLike({ messageId: "om_1", chatId: "oc_test_chat", chatName: "测试群", openId: "ou_sender", senderName: "张三", score: 8, emoji: "THUMBSUP", preview: "分享一个好方法", at: Date.now() });
    const app = await buildServer(AUTH);

    const member = authCookie("ou_member");
    const stats = await app.inject({ method: "GET", url: "/api/admin/group-qa/stats", headers: { cookie: member } });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().entries[0].chatName).toBe("测试群");
    expect(stats.body).not.toContain("oc_test_chat");
    const likes = await app.inject({ method: "GET", url: "/api/admin/group-qa/likes", headers: { cookie: member } });
    expect(likes.json().entries[0].senderName).toBe("张三");
    expect(likes.body).not.toContain("oc_test_chat");
    expect(likes.body).not.toContain("ou_sender");

    const admin = await app.inject({ method: "GET", url: "/api/admin/group-qa/likes", headers: { cookie: authCookie("admin") } });
    expect(admin.json().entries[0]).toMatchObject({ chatId: "oc_test_chat", openId: "ou_sender" });
    await app.close();
  });

  it("Web 通知：成员可以查看全站开关，但不能修改", async () => {
    const { setPageVisibility } = await import("../services/admin-visibility/index.js");
    await seedAdmin();
    await seedUser("ou_member");
    await setPageVisibility("web-notify", "all", "system");
    const app = await buildServer(AUTH);
    const member = authCookie("ou_member");
    const before = await app.inject({ method: "GET", url: "/api/admin/settings/web-notify", headers: { cookie: member } });
    expect(before.statusCode).toBe(200);
    const patch = await app.inject({ method: "PATCH", url: "/api/admin/settings/web-notify", headers: { cookie: member, "content-type": "application/json" }, payload: { enabled: !before.json().enabled } });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toBe("admin_only");
    const after = await app.inject({ method: "GET", url: "/api/admin/settings/web-notify", headers: { cookie: member } });
    expect(after.json()).toEqual(before.json());
    const byAdmin = await app.inject({ method: "PATCH", url: "/api/admin/settings/web-notify", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { enabled: !before.json().enabled } });
    expect(byAdmin.statusCode).toBe(200);
    await app.close();
  });
});
