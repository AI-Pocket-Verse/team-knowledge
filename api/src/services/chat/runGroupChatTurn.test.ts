import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { invalidateProviderCache } from "../llm/registry.js";
import { runGroupChatTurn } from "./runGroupChatTurn.js";
import type { ChatTurnChunk } from "./runChatTurn.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../../scripts/fake-claude.sh");
const log = { info() {}, warn() {}, error() {} } as never;

describe("runGroupChatTurn", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "群里你好";
  });
  afterAll(async () => { await disconnectDb(); });

  it("streams an answer but persists nothing (stateless)", async () => {
    const chunks: ChatTurnChunk[] = [];
    await runGroupChatTurn({
      text: "产品怎么用",
      signal: new AbortController().signal,
      onChunk: (c) => chunks.push(c),
      log,
    });
    expect(chunks.some((c) => c.type === "token")).toBe(true);
    expect(chunks.at(-1)?.type).toBe("done");
    // 隐私/无状态硬约束:群 turn 绝不建会话、绝不写消息。
    expect(await prisma.conversation.count()).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
  });
});
