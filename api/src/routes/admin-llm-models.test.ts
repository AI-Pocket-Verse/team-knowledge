import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { applyLlmModelsFromDb } from "../services/settings.js";
import { getProvider, invalidateProviderCache } from "../services/llm/registry.js";
import { setModelOverride } from "../services/llm/model-choice.js";
import { ClaudeCliProvider } from "../services/llm/claude-cli.js";
import { CodexCliProvider } from "../services/llm/codex-cli.js";
import type { LLMProvider } from "../services/llm/types.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../scripts/fake-claude.sh");
const FAKE_CODEX = path.resolve(__dirname, "../../scripts/fake-codex.sh");
const URL = "/api/admin/settings/llm-models";

// 跑一轮对话，返回 fake CLI 收到的命令行参数(逐行)。
async function spawnArgs(provider: LLMProvider, argsFile: string): Promise<string[]> {
  const ac = new AbortController();
  for await (const chunk of provider.chat({ systemPrompt: "sys", history: [], userMessage: "hi" }, ac.signal)) {
    if (chunk.type === "error") throw new Error(chunk.message);
  }
  return readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("/api/admin/settings/llm-models", () => {
  let argsDir: string;

  beforeEach(async () => {
    await resetDb();
    setModelOverride("claude", null);
    setModelOverride("codex", null);
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.CODEX_BIN = FAKE_CODEX;
    argsDir = mkdtempSync(path.join(tmpdir(), "tk-llm-models-"));
  });
  afterAll(async () => {
    setModelOverride("claude", null);
    setModelOverride("codex", null);
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
    await disconnectDb();
  });

  it("requires an admin", async () => {
    await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const app = await buildServer(AUTH);
    expect((await app.inject({ method: "GET", url: URL })).statusCode).toBe(401);
    const cookie = authCookie("u");
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: URL, headers: { cookie }, payload: { claude: "opus" } })).statusCode).toBe(403);
    await app.close();
  });

  it("defaults: nothing configured → CLI default model, no --model / -m passed", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "GET", url: URL, headers: { cookie: authCookie("admin") } });
    expect(r.json()).toEqual({
      claude: null, codex: null,
      envDefault: { claude: null, codex: null },
      active: { claude: null, codex: null },
    });
    await app.close();

    const claudeArgsFile = path.join(argsDir, "claude.txt");
    process.env.FAKE_CLAUDE_ARGS_FILE = claudeArgsFile;
    expect(await spawnArgs(await getProvider(), claudeArgsFile)).not.toContain("--model");
    const codexArgsFile = path.join(argsDir, "codex.txt");
    const codex = new CodexCliProvider({ bin: FAKE_CODEX, env: { ...process.env, FAKE_CODEX_ARGS_FILE: codexArgsFile } });
    expect(await spawnArgs(codex, codexArgsFile)).not.toContain("-m");
  });

  it("PUT sets the model: new chats spawn the CLI with it; .env value is the fallback", async () => {
    process.env.CLAUDE_MODEL = "sonnet";
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const before = (await app.inject({ method: "GET", url: URL, headers: { cookie } })).json();
    expect(before.envDefault.claude).toBe("sonnet");
    expect(before.active.claude).toBe("sonnet");

    const r = await app.inject({ method: "PUT", url: URL, headers: { cookie }, payload: { claude: " opus ", codex: "gpt-6.1-sol" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ claude: "opus", codex: "gpt-6.1-sol", active: { claude: "opus", codex: "gpt-6.1-sol" } });

    const claudeArgsFile = path.join(argsDir, "claude.txt");
    process.env.FAKE_CLAUDE_ARGS_FILE = claudeArgsFile;
    expect(argAfter(await spawnArgs(await getProvider(), claudeArgsFile), "--model")).toBe("opus");
    const codexArgsFile = path.join(argsDir, "codex.txt");
    const codex = new CodexCliProvider({ bin: FAKE_CODEX, env: { ...process.env, FAKE_CODEX_ARGS_FILE: codexArgsFile } });
    expect(argAfter(await spawnArgs(codex, codexArgsFile), "-m")).toBe("gpt-6.1-sol");

    // 后台汇总等显式指定模型的实例不受影响。
    const summaryArgsFile = path.join(argsDir, "summary.txt");
    const summary = new ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "haiku", env: { ...process.env, FAKE_CLAUDE_ARGS_FILE: summaryArgsFile } });
    expect(argAfter(await spawnArgs(summary, summaryArgsFile), "--model")).toBe("haiku");

    // 清空 → 回退 .env 的 CLAUDE_MODEL；未提供的字段保持不变。
    const cleared = await app.inject({ method: "PUT", url: URL, headers: { cookie }, payload: { claude: "" } });
    expect(cleared.json()).toMatchObject({ claude: null, codex: "gpt-6.1-sol", active: { claude: "sonnet", codex: "gpt-6.1-sol" } });
    expect(argAfter(await spawnArgs(await getProvider(), claudeArgsFile), "--model")).toBe("sonnet");
    await app.close();
  });

  it("rejects ids that could be parsed as CLI flags, without writing either field", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    for (const bad of ["--dangerously-skip-permissions", "-p", "opus sonnet", "a;b", "x".repeat(101)]) {
      const r = await app.inject({ method: "PUT", url: URL, headers: { cookie }, payload: { codex: "gpt-6.1-sol", claude: bad } });
      expect(r.statusCode).toBe(400);
      expect(["invalid_model_id", "invalid_input"]).toContain(r.json().error);
    }
    const after = (await app.inject({ method: "GET", url: URL, headers: { cookie } })).json();
    expect(after).toMatchObject({ claude: null, codex: null });
    expect(await prisma.setting.count({ where: { key: { in: ["llm.claude.model", "llm.codex.model"] } } })).toBe(0);
    await app.close();
  });

  it("survives a restart: the saved choice is loaded back from the database", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    await app.inject({ method: "PUT", url: URL, headers: { cookie: authCookie("admin") }, payload: { claude: "claude-opus-5-5" } });
    await app.close();

    // 模拟进程重启：内存覆盖值丢失，启动时由 applyLlmModelsFromDb 从库里恢复。
    setModelOverride("claude", null);
    await applyLlmModelsFromDb();
    const claudeArgsFile = path.join(argsDir, "claude.txt");
    process.env.FAKE_CLAUDE_ARGS_FILE = claudeArgsFile;
    expect(argAfter(await spawnArgs(await getProvider(), claudeArgsFile), "--model")).toBe("claude-opus-5-5");
  });
});

describe("/api/admin/settings/llm-binaries", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE; // 相当于 .env 里写的 CLAUDE_BIN
    process.env.CODEX_BIN = FAKE_CODEX;
  });
  afterAll(async () => { await disconnectDb(); });

  it("clearing the admin path falls back to the .env value instead of the bare command name", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const url = "/api/admin/settings/llm-binaries";
    // 管理员填的路径：一个名为 claude 的真 CLI(这里是指向 fake 的符号链接)
    const binDir = mkdtempSync(path.join(tmpdir(), "tk-bin-"));
    const adminClaude = path.join(binDir, "claude");
    symlinkSync(FAKE_CLAUDE, adminClaude);

    const set = await app.inject({ method: "PUT", url, headers: { cookie }, payload: { claudePath: adminClaude } });
    expect(set.statusCode).toBe(200);
    expect(process.env.CLAUDE_BIN).toBe(adminClaude);

    const cleared = await app.inject({ method: "PUT", url, headers: { cookie }, payload: { claudePath: "" } });
    expect(cleared.statusCode).toBe(200);
    expect(process.env.CLAUDE_BIN).toBe(FAKE_CLAUDE);
    expect(cleared.json().available.claude.ok).toBe(true);
    await app.close();
  });

  it("rejects paths that are not the claude / codex CLI, without saving them", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const url = "/api/admin/settings/llm-binaries";
    const binDir = mkdtempSync(path.join(tmpdir(), "tk-bin-"));
    // 名字对，但 --version 不是 Claude Code 的输出
    const impostor = path.join(binDir, "claude");
    writeFileSync(impostor, "#!/bin/sh\necho hello\n");
    chmodSync(impostor, 0o755);
    const cases: Array<[Record<string, string>, string]> = [
      [{ claudePath: "/bin/sh" }, "invalid_cli_path"],
      [{ codexPath: FAKE_CLAUDE }, "invalid_cli_path"],
      [{ claudePath: path.join(binDir, "missing", "claude") }, "cli_not_runnable"],
      [{ claudePath: impostor }, "not_a_cli"],
    ];
    for (const [payload, error] of cases) {
      const r = await app.inject({ method: "PUT", url, headers: { cookie }, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toBe(error);
    }
    expect(process.env.CLAUDE_BIN).toBe(FAKE_CLAUDE);
    expect(await prisma.setting.count({ where: { key: { in: ["llm.claude.bin", "llm.codex.bin"] } } })).toBe(0);
    await app.close();
  });

});
