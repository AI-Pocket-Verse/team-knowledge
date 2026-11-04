import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { createConversation, getOrCreateFeishuConversation } from "../chat/conversations.js";

// 多会话模型:每条会话(createConversation)上下文独立;飞书专用会话(singletonKey="feishu")
// 每用户唯一。取代旧的「按 userId × roleId 隔离」。
describe("experts/memory:多会话各自独立、飞书会话唯一", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("两条普通会话历史互不串;飞书会话独立且幂等", async () => {
    const u = await seedUser({ ssoId: "ou_a" });
    const a = await createConversation(u.id);
    const b = await createConversation(u.id);
    const feishu = await getOrCreateFeishuConversation(u.id);
    expect(new Set([a.id, b.id, feishu.id]).size).toBe(3); // 三条不同会话

    await prisma.chatMessage.create({ data: { conversationId: a.id, role: "user", content: "只属于A", source: "web" } });
    const aMsgs = await prisma.chatMessage.findMany({ where: { conversationId: a.id } });
    const bMsgs = await prisma.chatMessage.findMany({ where: { conversationId: b.id } });
    expect(aMsgs.length).toBe(1);
    expect(bMsgs.length).toBe(0); // B 不含 A 的消息

    const feishuAgain = await getOrCreateFeishuConversation(u.id);
    expect(feishuAgain.id).toBe(feishu.id); // 飞书会话幂等复用
  });
});
