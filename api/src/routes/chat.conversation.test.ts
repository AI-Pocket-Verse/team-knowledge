import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { createConversation } from "../services/chat/conversations.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("GET /api/chat/conversation conversationId + 归属", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("需要 conversationId(缺 → 400)+ 归属校验(他人 → 404)", async () => {
    const user = await seedUser({ ssoId: "u" });
    const conv = await createConversation(user.id);
    await prisma.chatMessage.create({ data: { conversationId: conv.id, role: "user", content: "hi", source: "web" } });
    const app = await buildServer(AUTH);

    const miss = await app.inject({ method: "GET", url: "/api/chat/conversation", headers: { cookie: authCookie("u") } });
    expect(miss.statusCode).toBe(400);

    const ok = await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie: authCookie("u") } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().messages.length).toBe(1);

    const other = await seedUser({ ssoId: "o2" });
    const foreign = await createConversation(other.id);
    const denied = await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${foreign.id}`, headers: { cookie: authCookie("u") } });
    expect(denied.statusCode).toBe(404);
    await app.close();
  });

  it("DELETE 清当前会话消息(归属校验)", async () => {
    const user = await seedUser({ ssoId: "u" });
    const conv = await createConversation(user.id);
    await prisma.chatMessage.create({ data: { conversationId: conv.id, role: "user", content: "hi", source: "web" } });
    const app = await buildServer(AUTH);

    const del = await app.inject({ method: "DELETE", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie: authCookie("u") } });
    expect(del.statusCode).toBe(204);
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id } })).toBe(0);
    await app.close();
  });
});
