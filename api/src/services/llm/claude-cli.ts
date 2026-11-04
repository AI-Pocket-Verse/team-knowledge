// Claude Code 命令行 provider：以子进程调用本机已登录的 `claude`，流式解析输出。
// 工具默认全禁、单轮；带图时放开 Read 并多轮，让模型读图；联网检索按需开启 WebSearch。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { env as procEnv } from "node:process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChatCallOpts, ChatChunk, ChatPrompt, LLMProvider, ProviderHealth } from "./types.js";
import { startIdleHardTimer } from "./timeout.js";
import { activeModel } from "./model-choice.js";
import { L, appLang } from "../../utils/lang.js";

export interface ClaudeCliOpts {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /// Optional `--model` arg passed to the Claude CLI. Lets us spawn
  /// a cheaper/faster model for background work (e.g. summary refresh
  /// uses Haiku 4.5 by default — see services/llm/summary-provider.ts).
  /// Falls back to the CLI's own default model (typically Sonnet)
  /// when undefined.
  model?: string;
}

// 隔离参数：任何登录成员都能向助手提问，提示词里还可能混进文档、群消息、网页里的注入内容，
// 所以 claude 子进程不能碰服务器上的文件和服务用户自己的配置。
//  - --restricted:去掉 Bash 等能执行命令的内置工具，文件工具只能访问工作目录(本次的空临时目录)，
//    并忽略 user / project / local 设置文件(其中的 allow 规则、hooks、defaultMode 都不生效)。
//    需要 Claude Code 2.1.248 及以上，见 MIN_CLAUDE_VERSION。
//  - --safe-mode:不加载 CLAUDE.md、skills、plugins、hooks、MCP 等个人定制。
//  - --strict-mcp-config:只用 --mcp-config 给的 MCP 服务器(这里不给，即没有)。
// 注意 --allowedTools 只是「免确认」名单，不限制可用工具；真正限制可用工具的是 --tools。
export const CLAUDE_ISOLATION_ARGS = ["--restricted", "--safe-mode", "--strict-mcp-config"] as const;
export const MIN_CLAUDE_VERSION = "2.1.248";

// 选 claude CLI 的工具/轮数档位(纯函数,便于测)。优先级:webTools > images > 纯文本。
//  - webTools:放开 WebSearch/WebFetch(联网搜)+ 多轮(工具 round-trip 占轮);带图时并放开 Read 读图
//    (否则联网+图片同时存在会丢图——总台/门控路径放开联网后,带图的通用提问会读不到图);
//  - images:放开 Read 读图 + 多轮;
//  - 纯文本:工具全禁 + 单轮(现状,确定性最高)。
export function claudeToolArgs(opts?: { webTools?: boolean; images?: string[]; maxTurns?: number }): string[] {
  const hasImages = !!opts?.images && opts.images.length > 0;
  // webTools 路径允许调用方覆盖轮数(后台重任务放宽,避免过早 error_max_turns);其余档位不变。
  if (opts?.webTools) {
    const tools = `WebSearch,WebFetch${hasImages ? ",Read" : ""}`;
    return [`--tools=${tools}`, `--allowedTools=${tools}`, `--max-turns=${opts.maxTurns ?? 6}`];
  }
  if (hasImages) return ["--tools=Read", "--allowedTools=Read", "--max-turns=6"];
  return ["--tools=", "--allowedTools=", "--max-turns=1"];
}

// 比较 `claude --version` 输出里的版本号(如 "2.1.318 (Claude Code)")是否不低于 min。
export function claudeVersionAtLeast(versionOutput: string, min: string = MIN_CLAUDE_VERSION): boolean {
  const m = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const have = m.slice(1, 4).map(Number);
  const want = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}

// 服务进程自己的配置与密钥不交给 claude 子进程(登录凭据、代理、ANTHROPIC_* 等照常保留)。
// 隔离参数已经让模型没有读环境变量的工具，这里再去掉一层，防止以后放开工具时漏掉。
const APP_SECRET_ENV = /^(INTERNAL_API_TOKEN|DATABASE_URL|DATA_DIR|WHOAMI_URL|OPENAI_|VOLC_|FEISHU_|ADMIN_(OPEN_IDS|EMAILS|PHONES)$)/;
export function claudeSafeEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined && !APP_SECRET_ENV.test(k)) out[k] = v;
  }
  return out;
}

// 纯文本 / 联网档位共用的空工作目录(被清掉时重建)。
let sharedWorkDir: string | null = null;
export function claudeWorkDir(): string {
  if (!sharedWorkDir || !existsSync(sharedWorkDir)) sharedWorkDir = mkdtempSync(join(tmpdir(), "tk-claude-"));
  return sharedWorkDir;
}

// 读图档位：把本次图片复制进新建的临时目录作为工作目录，模型只能读到这几张图，
// 读不到上传目录里的其他文件。返回复制后的路径与清理函数。
export function stageImages(images: string[]): { dir: string; paths: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tk-claude-img-"));
  const paths = images.map((src, i) => {
    const dest = join(dir, `${i + 1}-${basename(src)}`);
    copyFileSync(src, dest);
    return dest;
  });
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 从一条 assistant/user 消息的 content 数组里抽联网命中的网页出处。容忍多种 claude CLI 形态:
//  - web_search_tool_result 块:content 为 [{type:"web_search_result", url, title}, ...]
//  - tool_use / server_tool_use 且 name=WebFetch:input.url(单个抓取的页面)
// 形态漂移时尽量多抽、绝不抛(出处是次要信息,缺了不影响回答)。
// 只收 http(s):出处会被前端渲染成可点击链接,javascript: / data: 等不能放行。
const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);
export function extractWebCitations(content: unknown): Array<{ url: string; title?: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ url: string; title?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; name?: string; input?: { url?: unknown }; content?: unknown };
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        const url = (r as { url?: unknown })?.url;
        const title = (r as { title?: unknown })?.title;
        if (typeof url === "string" && isHttpUrl(url)) out.push({ url, title: typeof title === "string" ? title : undefined });
      }
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      // 容忍 CLI 版本间命名漂移:WebFetch / web_fetch / web_search 等(大小写、蛇形不一)。
      const name = (b.name ?? "").toLowerCase().replace(/_/g, "");
      if ((name === "webfetch" || name === "websearch") && typeof b.input?.url === "string" && isHttpUrl(b.input.url)) {
        out.push({ url: b.input.url });
      }
    }
  }
  return out;
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name = "claude" as const;
  // 最近一次对话流里 `system` 初始化事件报告的模型 ID(如 claude-opus-4-…)。
  // 仅供后台「实际检测到 X」核对提示,不参与对外显示(对外用手填 curated 名)。
  // 服务重启后、首次调用前为 null;抓不到就保持 null(不影响任何对外行为)。
  lastModel: string | null = null;
  private readonly explicitBin: string | undefined;
  private readonly explicitEnv: NodeJS.ProcessEnv | undefined;
  private readonly explicitModel: string | undefined;

  constructor(opts: ClaudeCliOpts = {}) {
    // Resolved lazily per call so tests (and admin env flips) can change
    // CLAUDE_BIN after this object is constructed.
    this.explicitBin = opts.bin;
    this.explicitEnv = opts.env;
    this.explicitModel = opts.model;
  }

  private get bin(): string {
    return this.explicitBin ?? procEnv.CLAUDE_BIN ?? "claude";
  }
  private get env(): NodeJS.ProcessEnv {
    return this.explicitEnv ?? claudeSafeEnv(procEnv);
  }
  // 构造时显式指定的模型(如后台汇总用的小模型)优先，否则用后台设置 / .env 选择的模型。
  private get model(): string | undefined {
    return this.explicitModel ?? activeModel("claude");
  }

  async isAvailable(): Promise<ProviderHealth> {
    return new Promise((resolve) => {
      try {
        const p = spawn(this.bin, ["--version"], { env: this.env });
        let out = "";
        let stderr = "";
        p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
        p.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
        p.on("error", (err) => resolve({ ok: false, reason: err.message }));
        p.on("exit", (code) => {
          const version = out.trim();
          if (code !== 0) resolve({ ok: false, reason: stderr.trim() || `exit ${code}` });
          // 隔离参数(--restricted 等)需要较新的 CLI；旧版本会把它们当未知参数直接报错，这里提前说明原因。
          else if (!claudeVersionAtLeast(version)) resolve({ ok: false, version, reason: L(appLang(), `需要 Claude Code ${MIN_CLAUDE_VERSION} 或更高版本（当前 ${version}），请运行 claude update 升级`, `Claude Code ${MIN_CLAUDE_VERSION} or later is required (current ${version}). Run claude update to upgrade`) });
          else resolve({ ok: true, version });
        });
      } catch (e) {
        resolve({ ok: false, reason: (e as Error).message });
      }
    });
  }

  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk> {
    // (C) Synchronous spawn so the CLI cold-start overlaps with the
    // caller's prompt prep (retrieval + build + summary refresh).
    // The async generator returned at the bottom awaits `prompt`
    // before writing stdin — by then the child is usually already
    // primed for input, so first-token latency drops by the spawn
    // cold-start (~1-3s depending on environment).
    if (signal.aborted) return abortedIterable();

    const modelArgs = this.model ? ["--model", this.model] : [];
    // Optional thinking budget control. When LLM_EFFORT is set
    // ("low"|"medium"|"high"|"xhigh"|"max"), forward it to the CLI.
    // higher = more time the model spends in `thinking` blocks before
    // answering. Unset = CLI default (currently "medium"). The
    // downstream parser surfaces thinking blocks via ChatChunk
    // {type:"thinking"}; the UI only renders a "深度思考中" indicator
    // when those events actually arrive, so flipping effort on/off
    // is the only knob needed to enable / disable the thinking UI.
    // 按调用覆盖优先(opts.effort),否则回退全局 LLM_EFFORT。让助手自答可单独调高
    // 思考强度以展示「思考过程」,而不必抬高所有调用(专家/分诊/汇总)的延迟与成本。
    const effort = opts?.effort ?? procEnv.LLM_EFFORT;
    const effortArgs = effort ? ["--effort", effort] : [];
    // 视觉:Claude CLI 没有图片附件参数,但能用 Read 工具原生读图。带图时
    // ① 只放开 Read(纯文本 --tools= 全禁)② 放开 max-turns(读图的 tool_use round-trip
    // 每次占一轮,1 轮塞不下「读图→回答」)③ 配合 --restricted,Read 只能访问工作目录。
    // 带图时把图片复制进本次专用的临时目录(工作目录)，模型只能读到这几张图；
    // 否则在共用的空目录里运行。两种情况都不继承 API 进程的工作目录(里面有 .env.prod)。
    let staged: ReturnType<typeof stageImages> | null = null;
    try {
      staged = opts?.images?.length ? stageImages(opts.images) : null;
    } catch (e) {
      return errorIterable(`image staging failed: ${(e as Error).message}`);
    }
    const images = staged?.paths ?? [];
    const toolArgs = claudeToolArgs({ ...opts, images });
    const args = [
      ...modelArgs,
      ...effortArgs,
      ...CLAUDE_ISOLATION_ARGS,
      "-p",
      "--output-format=stream-json",
      // Claude CLI rejects "--print + stream-json" without --verbose
      // (error: "When using --print, --output-format=stream-json
      // requires --verbose"). We still discard the verbose lines —
      // only the content_block_delta JSON events are parsed downstream.
      "--verbose",
      // Without this, the CLI emits a single whole-message `assistant`
      // event with the full reply (no token-level deltas). Turning this
      // on makes it stream Anthropic-API-shaped `stream_event` frames
      // (message_start / content_block_delta / message_stop) which is
      // what the parser below expects.
      "--include-partial-messages",
      ...toolArgs,
    ];
    const child = spawn(this.bin, args, {
      env: this.env,
      cwd: staged?.dir ?? claudeWorkDir(),
    });

    // Wire exit listener FIRST so it can't be missed if the child
    // crashes during prompt prep (e.g. missing binary).
    // spawn 失败(如 CLAUDE_BIN 不存在 ENOENT)只走 'error' 事件;不监听会
    // 变成 unhandled 'error' 崩掉整个进程。记录原因,按非零退出统一上报;
    // stdin 同理(对没起来的子进程写入会在 stdin 流上再抛)。
    let spawnError: string | null = null;
    const exitPromise = new Promise<number>((res) => {
      child.on("exit", (c) => res(c ?? -1));
      child.on("error", (err) => { spawnError = err.message; res(-1); });
    });
    // 子进程结束(含启动失败)后删掉本次复制的图片。
    if (staged) void exitPromise.then(staged.cleanup);
    child.stdin.on("error", () => { /* 经 spawnError/exit 上报 */ });
    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    signal.addEventListener("abort", onAbort);
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });

    return this.iterateStream(child, exitPromise, onAbort, () => spawnError ?? stderr, prompt, signal, images);
  }

  private async *iterateStream(
    child: ChildProcessWithoutNullStreams,
    exitPromise: Promise<number>,
    onAbort: () => void,
    getStderr: () => string,
    promptArg: ChatPrompt | PromiseLike<ChatPrompt>,
    signal: AbortSignal,
    images: string[] = [],
  ): AsyncGenerator<ChatChunk> {
    // Await prompt; on rejection or mid-wait abort, kill the
    // already-spawned child cleanly.
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

    // Dual timer: idle (reset on every parsed frame) + hard cap. Started
    // HERE so it doesn't count retrieval / build prep as idle time.
    // Long healthy answers no longer get SIGKILL'd mid-stream; only
    // true hangs do. See startIdleHardTimer for env knobs.
    const timer = startIdleHardTimer(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    });

    try {
      child.stdin.write(buildPromptString(prompt, images));
      child.stdin.end();
    } catch { /* 子进程未起来(spawn error)→ 经 exitPromise 分支上报 */ }

    let buffer = "";
    // Real Claude CLI 2.x stream-json schema (with --include-partial-messages):
    //   {"type":"system",...}                                          ← discarded
    //   {"type":"stream_event","event":{"type":"message_start",...}}   ← discarded
    //   {"type":"stream_event","event":{"type":"content_block_start",  ← discarded
    //                                   "index":N,"content_block":{"type":"text",...}}}
    //   {"type":"stream_event","event":{"type":"content_block_delta",  ← THIS is the token
    //                                   "index":N,
    //                                   "delta":{"type":"text_delta","text":"…"}}}
    //   {"type":"assistant","message":{...full text...}}               ← discarded (would double-count)
    //   {"type":"stream_event","event":{"type":"content_block_stop",...}}
    //   {"type":"stream_event","event":{"type":"message_stop"}}
    //   {"type":"result","subtype":"success","is_error":false,         ← fallback text + error flag
    //                    "result":"…full reply…"}
    //
    // Older parsers in this file looked for {type:"text-delta",delta:"…"},
    // a schema the CLI never actually emitted — that bug surfaced as
    // "AI replies arrive blank, no error" because the loop yielded zero
    // tokens and finished cleanly.
    let yieldedAny = false;
    let resultText = "";
    let resultError: string | null = null;
    // 联网出处去重(整条流内同一 URL 只报一次)。
    const seenUrls = new Set<string>();
    // Per-index content-block type cache. With extended thinking the
    // CLI interleaves blocks like: index=0 thinking → index=1 text.
    // We need to know which kind a delta belongs to so a text_delta
    // inside a thinking block is routed to the thinking stream
    // rather than the answer body (some CLI versions stream thinking
    // text as text_delta within a thinking block).
    const blockTypeByIndex = new Map<number, "text" | "thinking" | "other">();
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        buffer += chunk.toString("utf8");
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let evt: { type?: unknown; event?: unknown; result?: unknown; is_error?: unknown; model?: unknown };
          try { evt = JSON.parse(line); } catch { continue; }
          // idle 计时器要答的问题是「CLI 还有没有反应」,任何一帧合法事件都已
          // 经回答了「有」,所以在这里统一 arm(),下面各分支不再各自 arm。
          //
          // 只在 text/thinking delta 上 arm 的话,webTools 路径(orchestrator
          // 的助手自答开了 WebSearch/WebFetch)在连续工具调用期间一帧正文都
          // 没有 —— 工具帧既不是 delta、tool_result 也不在 stream_event 里 ——
          // 超过 90s 就被当成卡死 SIGKILL,用户看到的是「没反应」而不是「在搜」。
          // 越界的长跑仍由 hard cap(永不重置)兜底,所以这里只会放宽不会失控。
          timer.arm();
          // `system`(subtype:"init")事件带本次实际使用的 model —— 缓存供后台核对。
          if (evt.type === "system" && typeof evt.model === "string" && evt.model) {
            this.lastModel = evt.model;
          }
          if (evt.type === "stream_event" && evt.event && typeof evt.event === "object") {
            const ev = evt.event as {
              type?: string;
              index?: number;
              content_block?: { type?: string };
              delta?: { type?: string; text?: string; thinking?: string };
            };
            if (ev.type === "content_block_start" && typeof ev.index === "number") {
              const cbType = ev.content_block?.type;
              if (cbType === "text") {
                blockTypeByIndex.set(ev.index, "text");
              } else if (cbType === "thinking" || cbType === "redacted_thinking") {
                blockTypeByIndex.set(ev.index, "thinking");
                // Empty-text thinking event = "thinking started" signal.
                // The UI flips into "深度思考中" indicator even when no
                // thinking_delta follows (CLI signs but doesn't emit
                // raw reasoning for some models).
                yield { type: "thinking", text: "" };
              } else {
                blockTypeByIndex.set(ev.index, "other");
              }
            } else if (ev.type === "content_block_delta" && typeof ev.index === "number" && ev.delta) {
              const blockType = blockTypeByIndex.get(ev.index);
              const d = ev.delta;
              if (blockType === "text" && d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
                yield { type: "token", text: d.text };
                yieldedAny = true;
              } else if (blockType === "thinking") {
                // thinking_delta is the documented shape carrying raw
                // reasoning text. signature_delta carries opaque
                // signing data — intentionally dropped (not user-facing).
                if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking.length > 0) {
                  yield { type: "thinking", text: d.thinking };
                } else if (d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
                  // Defensive: some CLI builds stream thinking content
                  // as text_delta INSIDE a thinking block. Route it to
                  // the thinking lane so it doesn't pollute the answer.
                  yield { type: "thinking", text: d.text };
                }
              }
            } else if (ev.type === "content_block_stop" && typeof ev.index === "number") {
              if (blockTypeByIndex.get(ev.index) === "thinking") {
                yield { type: "thinking_end" };
              }
            }
          } else if (evt.type === "result") {
            if (typeof evt.result === "string") resultText = evt.result;
            if (evt.is_error === true) {
              resultError = (typeof evt.result === "string" && evt.result.length > 0) ? evt.result : "claude returned an error";
            }
          } else if (evt.type === "assistant" || evt.type === "user") {
            // 联网工具的命中以「完整消息」形式出现(content 数组里的 web_search_tool_result /
            // WebFetch tool_use),deltas 难拼,所以从这里的完整 message 抽 URL 出处。
            const content = (evt as { message?: { content?: unknown } }).message?.content;
            for (const c of extractWebCitations(content)) {
              if (seenUrls.has(c.url)) continue;
              seenUrls.add(c.url);
              yield { type: "citation", url: c.url, title: c.title };
            }
          }
        }
      }

      const code = await exitPromise;
      const tReason = timer.reason();
      if (tReason === "idle") yield { type: "error", message: `claude idle for ${timer.idleMs}ms (no tokens received)` };
      else if (tReason === "hard") yield { type: "error", message: `claude exceeded ${timer.hardMs}ms hard cap` };
      else if (signal.aborted) yield { type: "error", message: "aborted" };
      else if (resultError) yield { type: "error", message: resultError };
      else if (code === 0) {
        // Defensive fallback: if --include-partial-messages stopped firing
        // deltas (CLI upgrade / schema drift), at least surface the full
        // result text rather than a silent empty bubble.
        if (!yieldedAny && resultText.length > 0) yield { type: "token", text: resultText };
        yield { type: "done" };
      }
      else yield { type: "error", message: getStderr().trim() || `claude exited ${code}` };
    } finally {
      timer.disarm();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// Returned synchronously from chat() when the signal was already
// aborted at entry — we never spawn the child at all in that case.
// Typed as AsyncGenerator (not AsyncIterable) to match the actual
// runtime value an `async function*` returns; for-await callers
// only need AsyncIterable, but the narrower type means tooling
// won't lose the .return()/.throw() methods if a future caller
// needs them.
async function* abortedIterable(): AsyncGenerator<ChatChunk> {
  yield { type: "error", message: "aborted" };
}

async function* errorIterable(message: string): AsyncGenerator<ChatChunk> {
  yield { type: "error", message };
}

function buildPromptString(input: ChatPrompt, images: string[] = []): string {
  const parts: string[] = [];
  parts.push(`<SYSTEM>\n${input.systemPrompt}\n</SYSTEM>\n`);
  if (input.history.length) {
    parts.push("<HISTORY>");
    for (const m of input.history) parts.push(`<${m.role.toUpperCase()}>\n${m.content}\n</${m.role.toUpperCase()}>`);
    parts.push("</HISTORY>\n");
  }
  if (images.length > 0) {
    // 带图轮次:argv 已放开 Read 工具(见 chat()),这里告诉模型图在哪、必须先看。
    parts.push("<IMAGES>");
    parts.push("用户随本条消息上传了图片,文件路径:");
    for (const p of images) parts.push(`- ${p}`);
    parts.push("请先用 Read 工具逐一查看以上图片,再结合图片内容回答问题。回答里不要提及文件路径或读取过程。");
    parts.push("</IMAGES>\n");
  }
  parts.push(`<QUESTION>\n${input.userMessage}\n</QUESTION>`);
  return parts.join("\n");
}
