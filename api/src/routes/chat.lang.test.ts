import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { invalidateProviderCache } from "../services/llm/registry.js";

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-claude.sh");
const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// 问答按提问人的界面语言回答：英文界面的请求，交给 claude 的提示词带英文输出指令；中文不带(与改造前一致)。
describe("POST /api/chat/message 回答语言", () => {
  let stdinFile: string;
  beforeEach(async () => {
    await resetDb();
    stdinFile = path.join(mkdtempSync(path.join(tmpdir(), "tk-chat-lang-")), "stdin.txt");
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "ok";
    process.env.FAKE_CLAUDE_STDIN_FILE = stdinFile;
    invalidateProviderCache();
  });
  afterEach(() => {
    delete process.env.CLAUDE_BIN; delete process.env.FAKE_CLAUDE_REPLY; delete process.env.FAKE_CLAUDE_STDIN_FILE;
    invalidateProviderCache();
  });
  afterAll(async () => { await disconnectDb(); });

  async function ask(headers: Record<string, string>): Promise<string> {
    await seedUser({ ssoId: "u" });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/chat/message",
      headers: { cookie: authCookie("u"), "content-type": "application/json", ...headers },
      payload: { content: "What is our rollback time limit?" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    return readFileSync(stdinFile, "utf8");
  }

  it("X-Lang: en → 提示词要求用英文回答", async () => {
    expect(await ask({ "x-lang": "en" })).toContain("[Output language]");
  });

  it("中文界面 / 没带语言 → 提示词不变", async () => {
    expect(await ask({ "x-lang": "zh" })).not.toContain("[Output language]");
  });
});
