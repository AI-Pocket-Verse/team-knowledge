import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { emitSelfNotification } from "../utils/notify/self.js";
import { setWebNotifySettings } from "../utils/notify/webNotifySettings.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedUser(ssoId: string) {
  return prisma.user.create({ data: { ssoId, displayName: ssoId.toUpperCase() } });
}

describe("Web 通知(事件完成)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("管理后台开关:默认全开;非管理员 403;PATCH 生效", async () => {
    await seedAdmin({ ssoId: "adm" });
    await seedUser("u1");
    const app = await buildServer(AUTH);

    // 非管理员 → 403
    expect((await app.inject({ url: "/api/admin/settings/web-notify", headers: { cookie: authCookie("u1") } })).statusCode).toBe(403);

    // 管理员默认全开
    const def = (await app.inject({ url: "/api/admin/settings/web-notify", headers: { cookie: authCookie("adm") } })).json();
    expect(def).toEqual({ enabled: true, automation: true, meeting: true, image: true });

    // 关掉「生图」这一类
    const patched = (await app.inject({
      method: "PATCH", url: "/api/admin/settings/web-notify",
      headers: { cookie: authCookie("adm"), "content-type": "application/json" }, payload: { image: false },
    })).json();
    expect(patched).toMatchObject({ enabled: true, image: false, automation: true });
    await app.close();
  });

  it("emitSelfNotification:写一条铃铛通知,list 返回 title/body/link,未读 +1", async () => {
    const u = await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");

    await emitSelfNotification({ userId: u.id, type: "automation_run", title: "任务完成:每日新闻", body: "已生成结果", link: "/automation", dedupeKey: "automation:r1" });

    const list = (await app.inject({ url: "/api/notifications", headers: { cookie } })).json();
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0]).toMatchObject({ type: "automation_run", title: "任务完成:每日新闻", body: "已生成结果", link: "/automation" });
    const count = (await app.inject({ url: "/api/notifications/unread-count", headers: { cookie } })).json();
    expect(count).toEqual({ count: 1 });
    await app.close();
  });

  it("幂等:同 dedupeKey 只写一条", async () => {
    const u = await seedUser("u1");
    await emitSelfNotification({ userId: u.id, type: "meeting_minutes", title: "纪要已生成", link: "/meeting/m1", dedupeKey: "meeting:m1" });
    await emitSelfNotification({ userId: u.id, type: "meeting_minutes", title: "纪要已生成(重生成)", link: "/meeting/m1", dedupeKey: "meeting:m1" });
    expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(1);
  });

  it("管理后台该类关闭 → 不写", async () => {
    const u = await seedUser("u1");
    await setWebNotifySettings({ image: false }, "adm");
    await emitSelfNotification({ userId: u.id, type: "image_gen", title: "生图完成", link: "/c/c1", dedupeKey: "image:x1" });
    expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(0);
  });

  it("管理后台总开关关闭 → 全部不写", async () => {
    const u = await seedUser("u1");
    await setWebNotifySettings({ enabled: false }, "adm");
    await emitSelfNotification({ userId: u.id, type: "automation_run", title: "任务完成", link: "/automation", dedupeKey: "automation:r2" });
    expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(0);
  });

  it("用户静音该类 → 不写", async () => {
    const u = await seedUser("u1");
    await prisma.notificationPref.create({ data: { userId: u.id, muteAutomation: true } });
    await emitSelfNotification({ userId: u.id, type: "automation_run", title: "任务完成", link: "/automation", dedupeKey: "automation:r3" });
    expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(0);
    // 另一类不受影响
    await emitSelfNotification({ userId: u.id, type: "meeting_minutes", title: "纪要", link: "/meeting/m2", dedupeKey: "meeting:m2" });
    expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(1);
  });
});
