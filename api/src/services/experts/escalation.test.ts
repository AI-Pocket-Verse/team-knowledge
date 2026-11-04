import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { createEscalation, resolveEscalation, expireEscalation, forwardEscalation } from "./escalation.js";

describe("experts/escalation", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("创建 pending;resolve 置 resolved + 写结论;重复 resolve 幂等(忽略)", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "卡在 A", question: "选哪个?", options: ["甲", "乙"], assigneeUserId: "u1" });
    expect(esc.status).toBe("pending");

    const r1 = await resolveEscalation(esc.id, { resolution: "选甲", by: "u1" });
    expect(r1.status).toBe("resolved");
    expect(r1.resolution).toBe("选甲");
    expect(r1.resolvedAt).not.toBeNull();

    const r2 = await resolveEscalation(esc.id, { resolution: "改乙", by: "u1" });
    expect(r2.status).toBe("resolved");
    expect(r2.resolution).toBe("选甲"); // 幂等:已终态不被覆盖
  });

  it("expire 把 pending 置 timeout;已 resolved 的不被 expire 覆盖", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: [], assigneeUserId: "u1" });
    await expireEscalation(a.id);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("timeout");

    const b = await createEscalation({ conversationId: "c2", roleId: role.id, background: "b", question: "q", options: [], assigneeUserId: "u1" });
    await resolveEscalation(b.id, { resolution: "ok", by: "u1" });
    await expireEscalation(b.id);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("resolved");
  });

  it("forward 改 assignee + 记 assignedById + 发卡;仅 pending 生效", async () => {
    const a = await prisma.user.create({ data: { ssoId: "ou_a", displayName: "A" } });
    const b = await prisma.user.create({ data: { ssoId: "ou_b", displayName: "B", isActive: true } });
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "卡住", question: "选哪个", options: ["甲"], assigneeUserId: a.id });
    let sentTo: string | null = null;
    const r = await forwardEscalation(esc.id, { toUserId: b.id, byUserId: a.id, roleName: "技术" }, { sendCard: async (openId) => { sentTo = openId; return { messageId: "m1" }; } });
    expect(r.ok).toBe(true);
    expect(r.cardSent).toBe(true);
    expect(sentTo).toBe("ou_b");
    const row = await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } });
    expect(row.assigneeUserId).toBe(b.id);
    expect(row.assignedById).toBe(a.id);
    expect(row.feishuMessageId).toBe("m1");
  });

  it("forward 目标停用 → 拒绝、不改单、不发卡", async () => {
    const a = await prisma.user.create({ data: { ssoId: "ou_a", displayName: "A" } });
    const dead = await prisma.user.create({ data: { ssoId: "ou_d", displayName: "D", isActive: false } });
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: [], assigneeUserId: a.id });
    let called = false;
    const r = await forwardEscalation(esc.id, { toUserId: dead.id, byUserId: a.id, roleName: "技术" }, { sendCard: async () => { called = true; return { messageId: "x" }; } });
    expect(r).toEqual({ ok: false, reason: "bad-target" });
    expect(called).toBe(false);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).assigneeUserId).toBe(a.id);
  });

  it("forward 非 pending(已 resolved)→ not-pending,不改派", async () => {
    const a = await prisma.user.create({ data: { ssoId: "ou_a", displayName: "A" } });
    const b = await prisma.user.create({ data: { ssoId: "ou_b", displayName: "B" } });
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: [], assigneeUserId: a.id });
    await resolveEscalation(esc.id, { resolution: "定了", by: a.id });
    const r = await forwardEscalation(esc.id, { toUserId: b.id, byUserId: a.id, roleName: "技术" }, { sendCard: async () => ({ messageId: "m" }) });
    expect(r).toEqual({ ok: false, reason: "not-pending" });
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).assigneeUserId).toBe(a.id);
  });
});
