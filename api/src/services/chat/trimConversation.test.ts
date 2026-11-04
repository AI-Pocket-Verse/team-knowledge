import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { trimConversation } from "./runChatTurn.js";
import { createConversation } from "./conversations.js";

describe("trimConversation(保留无上限)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("超过历史不再删除(保留全部)", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U" } });
    const conv = await createConversation(u.id);
    for (let i = 0; i < 250; i++) {
      await prisma.chatMessage.create({ data: { conversationId: conv.id, role: i % 2 ? "assistant" : "user", content: `m${i}`, source: "web" } });
    }
    await trimConversation(conv.id);
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id } })).toBe(250);
  });
});
