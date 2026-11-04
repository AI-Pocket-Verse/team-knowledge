import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { invalidateProviderCache } from "../llm/registry.js";
import { runChatTurn, type ChatTurnChunk } from "./runChatTurn.js";
import { createConversation } from "./conversations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../../scripts/fake-claude.sh");

// Minimal logger stub — runChatTurn only calls info/error/warn.
const log = { info() {}, warn() {}, error() {} } as never;

describe("runChatTurn", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "你好世界";
  });
  afterAll(async () => { await disconnectDb(); });

  it("emits cited first + done last, persists user+assistant with the given source", async () => {
    const u = await seedUser({ ssoId: "ou_x", displayName: "X" });
    const conv0 = await createConversation(u.id);
    const chunks: ChatTurnChunk[] = [];

    await runChatTurn({
      user: { id: u.id, isAdmin: u.isAdmin, chatPreference: u.chatPreference },
      conversationId: conv0.id,
      text: "在吗",
      scope: "feishu",
      signal: new AbortController().signal,
      onChunk: (c) => chunks.push(c),
      log,
    });

    // First event is the citation list; stream contains tokens; last is done.
    expect(chunks[0]?.type).toBe("cited");
    expect(chunks.some((c) => c.type === "token")).toBe(true);
    expect(chunks.at(-1)?.type).toBe("done");

    // Both turns persisted to the supplied conversation, tagged feishu.
    const conv = await prisma.conversation.findUnique({ where: { id: conv0.id } });
    expect(conv).toBeTruthy();
    const msgs = await prisma.chatMessage.findMany({
      where: { conversationId: conv!.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0]?.source).toBe("feishu");
    expect(msgs[1]?.source).toBe("feishu");
    expect(msgs[1]?.content).toContain("你好世界");
  });
});
