import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { env as procEnv } from "node:process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCallOpts, ChatChunk, ChatPrompt, LLMProvider, ProviderHealth } from "./types.js";
import { startIdleHardTimer } from "./timeout.js";
import { activeModel } from "./model-choice.js";

export interface CodexCliOpts {
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

// Upper bound on buffered codex stdout. The provider accumulates the full
// JSONL output before parsing on exit; this caps that buffer so a runaway
// child can't OOM the process between idle-timer arms. 16 MiB is far past any
// real agent_message payload (a meeting comment is a few hundred chars).
const MAX_CODEX_STDOUT_BYTES = 16 * 1024 * 1024;

// Codex is NON-streaming: `codex exec --json` emits nothing until the whole
// result is ready, then writes one JSON blob. The shared 90s idle timer (built
// for token streams, where idle = "stalled mid-answer") therefore measures total
// think-time and prematurely SIGKILLs large/slow requests — e.g. distilling many
// docs into a role skill. Give codex a much longer idle window (still bounded by
// the hard cap). Env-overridable via LLM_CODEX_IDLE_TIMEOUT_MS.
const CODEX_IDLE_MS = Number(procEnv.LLM_CODEX_IDLE_TIMEOUT_MS ?? 300_000);

export class CodexCliProvider implements LLMProvider {
  readonly name = "codex" as const;
  // 最近一次 `codex exec --json` 事件流里报告的模型名(尽力抓;codex 未必在事件里带
  // model,抓不到就保持 null)。仅供后台「实际检测到 X」核对,不参与对外显示。
  lastModel: string | null = null;
  private readonly explicitBin: string | undefined;
  private readonly explicitEnv: NodeJS.ProcessEnv | undefined;

  constructor(opts: CodexCliOpts = {}) {
    this.explicitBin = opts.bin;
    this.explicitEnv = opts.env;
  }

  private get bin(): string {
    return this.explicitBin ?? procEnv.CODEX_BIN ?? "codex";
  }
  private get env(): NodeJS.ProcessEnv {
    // 默认只传运行必需的变量，不把服务进程里的密钥交给带 shell 的 codex 子进程。
    return this.explicitEnv ?? codexSafeEnv(procEnv);
  }

  async isAvailable(): Promise<ProviderHealth> {
    return new Promise((resolve) => {
      try {
        const p = spawn(this.bin, ["--version"], { env: this.env });
        let out = ""; let stderr = "";
        p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
        p.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
        p.on("error", (err) => resolve({ ok: false, reason: err.message }));
        p.on("exit", (code) => code === 0
          ? resolve({ ok: true, version: out.trim() })
          : resolve({ ok: false, reason: stderr.trim() || `exit ${code}` }));
      } catch (e) {
        resolve({ ok: false, reason: (e as Error).message });
      }
    });
  }

  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk> {
    // (C) Mirror ClaudeCliProvider: spawn synchronously so the cold
    // start of codex CLI overlaps with the caller's prompt prep.
    if (signal.aborted) return abortedIterable();

    const child = spawn(this.bin, codexExecArgs({ ...opts, model: activeModel("codex") }), { env: this.env, cwd: codexWorkDir() });

    // Register exit listener BEFORE consuming stdio so we don't miss the
    // event if the child exits quickly.
    // spawn 失败(如二进制不存在 ENOENT)只走 ChildProcess 的 'error' 事件;
    // 不监听会变成 unhandled 'error' 直接崩掉整个进程(生产周报 cron 就栽在
    // 这里:CODEX_BIN 指向不存在的路径)。记录原因,按非零退出统一上报。
    // stdin 同理:对没起来的子进程写入会在 stdin 流上再抛一个 error。
    let spawnError: string | null = null;
    const exitPromise = new Promise<number>((res) => {
      child.on("exit", (c) => res(c ?? -1));
      child.on("error", (err) => { spawnError = err.message; res(-1); });
    });
    child.stdin.on("error", () => { /* 经 spawnError/exit 上报 */ });
    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    signal.addEventListener("abort", onAbort);

    return this.iterateStream(child, exitPromise, onAbort, () => spawnError, prompt, signal);
  }

  private async *iterateStream(
    child: ChildProcessWithoutNullStreams,
    exitPromise: Promise<number>,
    onAbort: () => void,
    getSpawnError: () => string | null,
    promptArg: ChatPrompt | PromiseLike<ChatPrompt>,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    // Await prompt; on rejection / mid-wait abort, kill the child.
    let prompt: ChatPrompt;
    try {
      prompt = await Promise.resolve(promptArg);
    } catch (e) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      signal.removeEventListener("abort", onAbort);
      yield { type: "error", message: `prompt build failed: ${(e as Error).message}` };
      return;
    }
    if (signal.aborted) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      signal.removeEventListener("abort", onAbort);
      yield { type: "error", message: "aborted" };
      return;
    }

    // Dual-timer guard (idle + hard cap). Started AFTER stdin write so
    // build prep doesn't count as idle. Codex doesn't stream tokens —
    // it writes the full JSON once and exits — so the idle window
    // effectively counts as "no output for Xms". We arm on every
    // stdout chunk so a large response that takes its time still
    // resets the idle clock.
    const timer = startIdleHardTimer(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, { idleMs: CODEX_IDLE_MS });

    try {
      child.stdin.write(buildPromptString(prompt));
      child.stdin.end();
    } catch { /* 子进程未起来(spawn error)→ 经 exitPromise 分支上报 */ }

    let stdout = "";
    let stderr = "";
    // Codex buffers ALL stdout, then parses once on exit (it doesn't stream
    // tokens). Without a cap a runaway / malicious child could grow `stdout`
    // unbounded — only the hard timer bounds it, and a child that floods bytes
    // FAST can OOM well before that fires. Cap the buffer: past the limit we
    // SIGKILL the child and surface an error instead of buffering more.
    let bufferExceeded = false;
    child.stdout.on("data", (b: Buffer) => {
      if (bufferExceeded) return;
      stdout += b.toString();
      timer.arm();
      if (stdout.length > MAX_CODEX_STDOUT_BYTES) {
        bufferExceeded = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });

    try {
      const code = await exitPromise;
      const tReason = timer.reason();
      if (bufferExceeded) { yield { type: "error", message: `codex output exceeded ${MAX_CODEX_STDOUT_BYTES} bytes` }; return; }
      if (tReason === "idle") { yield { type: "error", message: `codex idle for ${timer.idleMs}ms` }; return; }
      if (tReason === "hard") { yield { type: "error", message: `codex exceeded ${timer.hardMs}ms hard cap` }; return; }
      if (signal.aborted) { yield { type: "error", message: "aborted" }; return; }
      if (code !== 0) { yield { type: "error", message: getSpawnError() ?? (stderr.trim() || `codex exited ${code}`) }; return; }
      try {
        const m = extractCodexModel(stdout);
        if (m) this.lastModel = m;
        const content = extractAgentMessage(stdout);
        // 出处:codex 联网检索命中的抓取页 URL(web_search item 里 query 为 http(s) 链接的)。
        // 回灌为 citation → 上游 sources 埋点 /助手「网页出处」都能拿到,不再恒为 0。
        for (const c of extractCodexWebCitations(stdout)) yield { type: "citation", url: c.url, title: c.title };
        if (content) yield { type: "token", text: content };
        yield { type: "done" };
      } catch (e) {
        yield { type: "error", message: `codex output parse failed: ${(e as Error).message}` };
      }
    } finally {
      timer.disarm();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// codex 是带 shell 工具的 agent。把它放进一个空的临时目录运行，并只传必需的环境变量，
// 避免它在服务源码目录(含 .env.prod)里启动、或继承服务进程里的密钥。
// 注意：--sandbox read-only 只禁写，不限制读路径，所以多人模式(配置了 WHOAMI_URL)
// 不允许使用 codex 引擎，见 settings.ts 的 getLlmProvider。
// 系统会定期清理临时目录：目录没了就重建，否则 spawn 报 ENOENT，被误判成「codex 没装」。
let cachedWorkDir: string | null = null;
// 导出供单测。
export function codexWorkDir(): string {
  if (!cachedWorkDir || !existsSync(cachedWorkDir)) cachedWorkDir = mkdtempSync(join(tmpdir(), "tk-codex-"));
  return cachedWorkDir;
}

const CODEX_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TZ", "LANG", "LANGUAGE", "CODEX_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
// 导出供单测。
export function codexSafeEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined && (CODEX_ENV_KEYS.has(k) || k.startsWith("LC_"))) out[k] = v;
  }
  return out;
}

// codex `exec` 参数(纯函数,便于测)。
//  - --ignore-user-config:忽略宿主机 ~/.codex/config.toml(个人插件/技能/model 覆盖)。
//    否则服务端 codex 会继承开发者/服务用户的 plugins(github/browser/computer-use/figma…),
//    被带成「编程/办公 agent」去跑 shell(pwd/ls/rg)、挤占 skills 上下文预算,导致自动化
//    跑偏、产出「0 条」。auth 仍走 CODEX_HOME,不受影响 —— 让服务端以干净、确定的 agent 运行。
//  - --sandbox read-only / --skip-git-repo-check:只读沙箱；工作目录是空临时目录(非 git 仓库)。
//  - webTools:开联网检索(codex 默认关闭 web_search),与 claude 的 --allowedTools=WebSearch 对齐。
//  - images:走原生 `-i <file>`。
//  - model:后台设置 / .env 选择的模型，走 `-m <model>`；未设置时用 codex 默认模型。
export function codexExecArgs(opts?: { webTools?: boolean; images?: string[]; model?: string }): string[] {
  const modelArgs = opts?.model ? ["-m", opts.model] : [];
  const imageArgs = (opts?.images ?? []).flatMap((p) => ["-i", p]);
  const webArgs = opts?.webTools ? ["-c", "tools.web_search=true"] : [];
  return ["exec", "--json", "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check", ...modelArgs, ...webArgs, ...imageArgs];
}

// See claude-cli.ts for the AsyncGenerator-vs-AsyncIterable rationale.
async function* abortedIterable(): AsyncGenerator<ChatChunk> {
  yield { type: "error", message: "aborted" };
}

function buildPromptString(input: ChatPrompt): string {
  const parts: string[] = [];
  parts.push(input.systemPrompt);
  for (const m of input.history) parts.push(`${m.role}: ${m.content}`);
  parts.push(`user: ${input.userMessage}`);
  return parts.join("\n\n");
}

// `codex exec --json` streams JSONL — one event object per line, e.g.:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
// The assistant's reply lives in the agent_message item(s). Parse line by line
// (like ClaudeCliProvider) — JSON.parse on the whole blob dies at line 2.
// Throw only when NO line is valid JSON (genuinely malformed output); a valid
// stream that simply carries no agent_message yields an empty reply, not an error.
function extractAgentMessage(stdout: string): string {
  const parts: string[] = [];
  let sawEvent = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: { type?: string; item?: { type?: string; text?: unknown } };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON noise lines, mirroring claude-cli.ts
    }
    sawEvent = true;
    if (evt.type === "item.completed" && evt.item?.type === "agent_message" && typeof evt.item.text === "string") {
      parts.push(evt.item.text);
    }
  }
  if (!sawEvent) throw new Error("no JSON events in codex output");
  return parts.join("");
}

// 尽力从 codex `--json` 事件里抠出「模型名」。codex 各版本 schema 不一,可能出现在
//   {"type":"thread.started","model":"..."} / {"...","item":{"model":"..."}} / {"session":{"model":"..."}}
// 等位置,也可能【根本不带】。故递归找第一个键名为 model 的字符串值;找不到返回 null
// (调用方保持 lastModel 不变)。纯尽力,绝不抛。
export function extractCodexModel(stdout: string): string | null {
  const findModel = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== "object" || depth > 6) return null;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "model" && typeof val === "string" && val.trim()) return val.trim();
      const nested = findModel(val, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let evt: unknown;
    try { evt = JSON.parse(t); } catch { continue; }
    const m = findModel(evt, 0);
    if (m) return m;
  }
  return null;
}

// 从 codex `--json` 事件里抽联网检索命中的网页出处。两个来源(兼容不同 codex 版本):
//   ① web_search item 的 query 恰为 http(s) 链接时(某些版本抓取具体页面会这样) → 作出处;
//   ② 当前 codex(0.141+)的 web_search item 只带【搜索词】、不带结果 URL —— 真正的来源 URL
//      由模型写进最终 agent_message 文本里(如卡片 JSON / markdown 链接)。从答案文本正则抽
//      http(s) 链接作出处。这修掉了「codex 明明联网了 sources 却恒为 0」的埋点/出处失真。
// 去重后返回;形态漂移时尽量多抽、绝不抛(出处是次要信息)。
export function extractCodexWebCitations(stdout: string): Array<{ url: string; title?: string }> {
  const out: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    // 去掉 URL 尾部常见的黏连标点(JSON/markdown/中文标点),避免把 `)`、`"`、`。` 带进来。
    const url = raw.replace(/[.,;:'"）)\]，。、]+$/, "");
    if (/^https?:\/\//i.test(url) && !seen.has(url)) { seen.add(url); out.push({ url }); }
  };
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let evt: { type?: string; item?: { type?: string; query?: unknown; text?: unknown } };
    try { evt = JSON.parse(t); } catch { continue; }
    if (evt.type !== "item.completed" || !evt.item) continue;
    if (evt.item.type === "web_search" && typeof evt.item.query === "string" && /^https?:\/\//i.test(evt.item.query)) {
      add(evt.item.query); // ① URL 形态的 web_search query
    } else if (evt.item.type === "agent_message" && typeof evt.item.text === "string") {
      for (const m of evt.item.text.matchAll(/https?:\/\/[^\s"'）)\]，。、,;]+/g)) add(m[0]); // ② 答案里引用的 URL
    }
  }
  return out;
}
