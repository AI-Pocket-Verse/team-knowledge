import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("../feishuGateway.js", () => ({
  feishuGateway: { notify: (...a: unknown[]) => notify(...a) },
  FeishuGatewayError: class FeishuGatewayError extends Error {},
}));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { kickDispatch } from "./dispatcher.js";

function makeNotif(recipientId: string, over: Record<string, unknown> = {}) {
  return prisma.notification.create({
    data: {
      recipientId,
      type: "article_like",
      // articleId omitted (nullable) — these tests don't need a real subject doc,
      // and articleId now FKs to Article (a fake id would violate the constraint).
      payload: JSON.stringify({ actorName: "X", articleTitle: "T" }),
      feishuState: "pending",
      ...over,
    },
  });
}

describe("kickDispatch", () => {
  beforeEach(async () => { await resetDb(); notify.mockReset(); });
  afterAll(async () => { await disconnectDb(); });

  it("sends a pending notification to an ou_* recipient and marks it sent", async () => {
    notify.mockResolvedValue({ messageId: "om_1" });
    const u = await seedUser({ ssoId: "ou_real" });
    const n = await makeNotif(u.id);

    await kickDispatch();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe("ou_real");
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("sent");
    expect(after?.feishuMsgId).toBe("om_1");
  });

  it("skips Feishu when the recipient ssoId is not an open_id", async () => {
    const u = await seedUser({ ssoId: "cuid-not-an-open-id" });
    const n = await makeNotif(u.id);
    await kickDispatch();
    expect(notify).not.toHaveBeenCalled();
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("skipped");
  });

  it("over the per-minute cap, leaves the row pending (deferred, not dropped)", async () => {
    const u = await seedUser({ ssoId: "ou_hot" });
    // 5 ACTUALLY SENT in the last minute (cap) — the window counts feishuSentAt.
    for (let i = 0; i < 5; i++) await makeNotif(u.id, { feishuState: "sent", feishuSentAt: new Date() });
    const n = await makeNotif(u.id); // pending
    await kickDispatch();
    expect(notify).not.toHaveBeenCalled();
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("pending"); // retried on a later pass, not "skipped"
  });

  it("积压补发:很久前创建/发送的行不占用限频窗口(限频按 feishuSentAt 而非 createdAt)", async () => {
    notify.mockResolvedValue({ messageId: "om_2" });
    const u = await seedUser({ ssoId: "ou_backlog" });
    // 历史上发过 5 条,但都在窗口(60s)之外 —— 不该挡住新的待发行。
    const old = new Date(Date.now() - 5 * 60_000);
    for (let i = 0; i < 5; i++) await makeNotif(u.id, { feishuState: "sent", feishuSentAt: old, createdAt: old });
    const n = await makeNotif(u.id);
    await kickDispatch();
    expect(notify).toHaveBeenCalledTimes(1);
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("sent");
    expect(after?.feishuSentAt).not.toBeNull(); // 成功发送时落下发送时刻,供后续限频统计
  });

  it("marks failed + increments tries when the send throws", async () => {
    notify.mockRejectedValue(new Error("boom"));
    const u = await seedUser({ ssoId: "ou_real" });
    const n = await makeNotif(u.id);
    await kickDispatch();
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("failed");
    expect(after?.feishuTries).toBe(1);
  });

  it("已停用的收件人:不发飞书,行标 skipped", async () => {
    const u = await seedUser({ ssoId: "ou_gone", isActive: false });
    const n = await makeNotif(u.id);
    await kickDispatch();
    expect(notify).not.toHaveBeenCalled();
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("skipped");
  });

  it("受限收件人的积压行不饿死其他人(选取时排除已达上限的收件人)", async () => {
    notify.mockResolvedValue({ messageId: "om_b" });
    const hot = await seedUser({ ssoId: "ou_hot2" });
    const other = await seedUser({ ssoId: "ou_other" });
    for (let i = 0; i < 5; i++) await makeNotif(hot.id, { feishuState: "sent", feishuSentAt: new Date() });
    const base = Date.now() - 600_000;
    for (let i = 0; i < 60; i++) await makeNotif(hot.id, { createdAt: new Date(base + i) });
    const n = await makeNotif(other.id); // 更新的一条
    await kickDispatch();
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.feishuState).toBe("sent");
  });

  describe("飞书失败后的退避重试", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("连续轮询不会把行在几秒内耗尽;网关恢复且过了退避期后补发", async () => {
      const u = await seedUser({ ssoId: "ou_retry" });
      const n = await makeNotif(u.id);
      notify.mockRejectedValue(new Error("boom"));
      await kickDispatch();
      await kickDispatch(); // 退避期内:不应再次尝试
      await kickDispatch();
      expect(notify).toHaveBeenCalledTimes(1);
      let row = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(row?.feishuTries).toBe(1);

      notify.mockReset();
      notify.mockResolvedValue({ messageId: "om_ok" });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await kickDispatch();
      row = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(row?.feishuState).toBe("sent");
    });

    it("退避中的行超过 1000 条时轮询不报错,新来的通知照常发送", async () => {
      // 每人 5 条,避免撞上每分钟限频;失败不计入限频窗口。
      const users = await Promise.all(Array.from({ length: 220 }, (_, i) => seedUser({ ssoId: `ou_bulk${i}` })));
      await prisma.notification.createMany({
        data: users.flatMap((u) => Array.from({ length: 5 }, () => ({
          recipientId: u.id, type: "article_like", payload: JSON.stringify({ actorName: "X", articleTitle: "T" }), feishuState: "pending",
        }))),
      });
      notify.mockRejectedValue(new Error("boom"));
      for (let i = 0; i < 23; i++) await kickDispatch(); // 50 条一批,1100 条全部进入退避
      expect(await prisma.notification.count({ where: { feishuState: "failed" } })).toBe(1100);

      notify.mockReset();
      notify.mockResolvedValue({ messageId: "om_new" });
      const fresh = await seedUser({ ssoId: "ou_fresh" });
      const n = await makeNotif(fresh.id);
      await kickDispatch();
      const row = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(row?.feishuState).toBe("sent");
    }, 60_000);
  });
});
