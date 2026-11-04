import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

function notif(recipientId: string, over: Record<string, unknown> = {}) {
  return prisma.notification.create({
    data: {
      recipientId,
      type: "article_like",
      // articleId omitted (nullable) — list/unread/prefs tests assert on payload
      // fields, not the subject id; articleId now FKs to Article.
      payload: JSON.stringify({ actorName: "张三", articleTitle: "PRD" }),
      ...over,
    },
  });
}

describe("notifications REST", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("lists only the caller's notifications, newest first; unread-count + read work", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const other = await seedUser({ ssoId: "u2" });
    await notif(me.id, { readAt: new Date() }); // read
    await notif(me.id); // unread
    await notif(other.id); // someone else's — must NOT appear

    const app = await buildServer(AUTH);
    const list = await app.inject({ url: "/api/notifications", headers: { cookie: authCookie("u1") } });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { notifications: Array<{ articleTitle: string; actorName: string }> };
    expect(body.notifications.length).toBe(2);
    expect(body.notifications[0]!.articleTitle).toBe("PRD");
    expect(body.notifications[0]!.actorName).toBe("张三");

    const count = await app.inject({ url: "/api/notifications/unread-count", headers: { cookie: authCookie("u1") } });
    expect(count.json()).toEqual({ count: 1 });

    const read = await app.inject({
      method: "POST", url: "/api/notifications/read",
      headers: { cookie: authCookie("u1") }, payload: {},
    });
    expect(read.json()).toMatchObject({ ok: true, unread: 0 });
    await app.close();
  });

  it("read({articleId}) 只清该文章的未读(打开文章自动清红点),其它文章不受影响", async () => {
    const me = await seedUser({ ssoId: "u1" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a1 = await prisma.article.create({ data: { title: "A1", contentMarkdown: "x", roleId: role.id, createdById: me.id } });
    const a2 = await prisma.article.create({ data: { title: "A2", contentMarkdown: "x", roleId: role.id, createdById: me.id } });
    await notif(me.id, { articleId: a1.id });
    await notif(me.id, { articleId: a1.id });
    await notif(me.id, { articleId: a2.id });

    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/notifications/read",
      headers: { cookie: authCookie("u1") }, payload: { articleId: a1.id },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, unread: 1 });

    const left = await prisma.notification.findMany({ where: { recipientId: me.id, readAt: null } });
    expect(left).toHaveLength(1);
    expect(left[0]!.articleId).toBe(a2.id);
    await app.close();
  });

  it("prefs: returns defaults, applies a partial update, and persists it", async () => {
    await seedUser({ ssoId: "u1" });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");

    const d = await app.inject({ url: "/api/notifications/prefs", headers: { cookie } });
    expect(d.json()).toEqual({
      muteLikes: false, muteFavorites: false, muteComments: false, feishuEnabled: true,
      muteAutomation: false, muteMeeting: false, muteImage: false, webEnabled: true,
    });

    const put = await app.inject({
      method: "PUT", url: "/api/notifications/prefs",
      headers: { cookie }, payload: { muteLikes: true, feishuEnabled: false },
    });
    expect(put.json()).toMatchObject({ muteLikes: true, muteComments: false, feishuEnabled: false });

    const g = await app.inject({ url: "/api/notifications/prefs", headers: { cookie } });
    expect(g.json()).toMatchObject({ muteLikes: true, feishuEnabled: false }); // persisted
    await app.close();
  });

  it("401 without a session", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ url: "/api/notifications" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});
