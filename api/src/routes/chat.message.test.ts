import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { invalidateProviderCache } from "../services/llm/registry.js";
import { createConversation } from "../services/chat/conversations.js";

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-claude.sh");
const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("POST /api/chat/message conversationId", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "好的";
    invalidateProviderCache();
  });
  afterEach(() => { delete process.env.CLAUDE_BIN; delete process.env.FAKE_CLAUDE_REPLY; invalidateProviderCache(); });
  afterAll(async () => { await disconnectDb(); });

  it("带 conversationId → 消息落到该会话", async () => {
    const user = await seedUser({ ssoId: "u" });
    const conv = await createConversation(user.id);
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/chat/message",
      headers: { cookie: authCookie("u"), "content-type": "application/json" },
      payload: { content: "hi", conversationId: conv.id },
    });
    expect(res.statusCode).toBe(200);
    const msgs = await prisma.chatMessage.findMany({ where: { conversationId: conv.id } });
    expect(msgs.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    await app.close();
  });

  it("缺省 conversationId → 新建会话并落库", async () => {
    const user = await seedUser({ ssoId: "u" });
    const before = await prisma.conversation.count({ where: { userId: user.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/chat/message",
      headers: { cookie: authCookie("u"), "content-type": "application/json" },
      payload: { content: "hi" },
    });
    expect(res.statusCode).toBe(200);
    const after = await prisma.conversation.count({ where: { userId: user.id } });
    expect(after).toBe(before + 1);
    await app.close();
  });

  it("他人 conversationId → 不写入越权会话(改用新建)", async () => {
    const user = await seedUser({ ssoId: "u" });
    const other = await seedUser({ ssoId: "other" });
    const foreign = await createConversation(other.id);
    const app = await buildServer(AUTH);
    await app.inject({
      method: "POST", url: "/api/chat/message",
      headers: { cookie: authCookie("u"), "content-type": "application/json" },
      payload: { content: "hi", conversationId: foreign.id },
    });
    expect(await prisma.chatMessage.count({ where: { conversationId: foreign.id } })).toBe(0);
    await app.close();
  });
});
