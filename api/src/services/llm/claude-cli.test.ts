import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ClaudeCliProvider, CLAUDE_ISOLATION_ARGS, MIN_CLAUDE_VERSION, claudeSafeEnv, claudeToolArgs, claudeVersionAtLeast, extractWebCitations } from "./claude-cli.js";

describe("claudeToolArgs", () => {
  // --tools 才是真正限制可用工具的参数(--allowedTools 只是免确认名单)，每个档位都必须带上。
  it("webTools → 只有 WebSearch/WebFetch + 多轮", () => {
    expect(claudeToolArgs({ webTools: true })).toEqual(["--tools=WebSearch,WebFetch", "--allowedTools=WebSearch,WebFetch", "--max-turns=6"]);
  });
  it("缺省 → 工具全禁 + 单轮", () => {
    expect(claudeToolArgs()).toEqual(["--tools=", "--allowedTools=", "--max-turns=1"]);
    expect(claudeToolArgs({})).toEqual(["--tools=", "--allowedTools=", "--max-turns=1"]);
  });
  it("仅图片 → 只有 Read + 多轮", () => {
    expect(claudeToolArgs({ images: ["/x.png"] })).toEqual(["--tools=Read", "--allowedTools=Read", "--max-turns=6"]);
  });
  it("联网 + 图片 → WebSearch/WebFetch 并放开 Read(不丢图)", () => {
    expect(claudeToolArgs({ webTools: true, images: ["/x.png"] })).toEqual(["--tools=WebSearch,WebFetch,Read", "--allowedTools=WebSearch,WebFetch,Read", "--max-turns=6"]);
  });
});

describe("claudeVersionAtLeast", () => {
  it("按数字逐段比较，识别 CLI 的版本输出", () => {
    expect(claudeVersionAtLeast("2.1.318 (Claude Code)")).toBe(true);
    expect(claudeVersionAtLeast(MIN_CLAUDE_VERSION)).toBe(true);
    expect(claudeVersionAtLeast("2.1.247 (Claude Code)")).toBe(false);
    expect(claudeVersionAtLeast("2.0.999")).toBe(false);
    expect(claudeVersionAtLeast("3.0.0")).toBe(true);
    expect(claudeVersionAtLeast("not a version")).toBe(false);
  });
});

describe("claudeSafeEnv", () => {
  it("去掉服务自己的密钥与配置，保留登录与代理相关变量", () => {
    const env = claudeSafeEnv({
      PATH: "/usr/bin", HOME: "/home/kb", HTTPS_PROXY: "http://127.0.0.1:7890", ANTHROPIC_API_KEY: "sk-test", CLAUDE_CONFIG_DIR: "/c",
      INTERNAL_API_TOKEN: "t", DATABASE_URL: "file:x", OPENAI_API_KEY: "o", VOLC_STT_API_KEY: "v", FEISHU_MEETING_NOTIFY_CHAT_IDS: "c", ADMIN_EMAILS: "a@example.com", WHOAMI_URL: "http://x",
    });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "HTTPS_PROXY", "PATH"]);
  });
});

describe("extractWebCitations", () => {
  it("抽 web_search_tool_result + WebFetch;非数组/异常块 → 跳过不抛", () => {
    expect(extractWebCitations(undefined)).toEqual([]);
    expect(extractWebCitations("nope")).toEqual([]);
    const cites = extractWebCitations([
      { type: "text", text: "hi" },
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://x/1", title: "T1" }, { url: "" }] },
      { type: "server_tool_use", name: "WebFetch", input: { url: "https://x/2" } },
      { type: "tool_use", name: "Read", input: { url: "https://ignore" } },
    ]);
    expect(cites).toEqual([{ url: "https://x/1", title: "T1" }, { url: "https://x/2" }]);
  });
});

describe("extractWebCitations 协议白名单", () => {
  it("只收 http(s),丢弃 javascript: / data: / file: 等", () => {
    const cites = extractWebCitations([
      {
        type: "web_search_tool_result",
        content: [
          { url: "javascript:alert(1)", title: "bad" },
          { url: "data:text/html,x" },
          { url: "HTTP://ok.example/a", title: "ok" },
        ],
      },
      { type: "tool_use", name: "WebFetch", input: { url: "file:///etc/passwd" } },
      { type: "tool_use", name: "WebFetch", input: { url: "https://ok.example/b" } },
    ]);
    expect(cites).toEqual([{ url: "HTTP://ok.example/a", title: "ok" }, { url: "https://ok.example/b" }]);
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(__dirname, "../../../scripts/fake-claude.sh");

function newProvider(env: Record<string, string> = {}): ClaudeCliProvider {
  return new ClaudeCliProvider({ bin: FAKE, env: { ...process.env, ...env } });
}

async function collect(provider: ClaudeCliProvider, msg: string) {
  const out: string[] = [];
  const thinking: string[] = [];
  const citations: { url: string; title?: string }[] = [];
  let thinkingStartedCount = 0;
  let thinkingEnded = false;
  let done = false;
  let err: string | null = null;
  const ac = new AbortController();
  for await (const chunk of provider.chat({
    systemPrompt: "sys", history: [], userMessage: msg,
  }, ac.signal)) {
    if (chunk.type === "token") out.push(chunk.text);
    else if (chunk.type === "thinking") {
      if (chunk.text === "") thinkingStartedCount += 1;
      else thinking.push(chunk.text);
    }
    else if (chunk.type === "thinking_end") thinkingEnded = true;
    else if (chunk.type === "citation") citations.push({ url: chunk.url, title: chunk.title });
    else if (chunk.type === "done") done = true;
    else if (chunk.type === "error") err = chunk.message;
  }
  return { text: out.join(""), thinking: thinking.join(""), citations, thinkingStartedCount, thinkingEnded, done, err };
}

describe("ClaudeCliProvider 子进程隔离", () => {
  it("每次调用都带隔离参数，在空临时目录里运行，不继承 API 的工作目录", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tk-claude-test-"));
    const argsFile = path.join(dir, "args.txt");
    const cwdFile = path.join(dir, "cwd.txt");
    for (const opts of [undefined, { webTools: true }]) {
      const p = newProvider({ FAKE_CLAUDE_ARGS_FILE: argsFile, FAKE_CLAUDE_CWD_FILE: cwdFile });
      const ac = new AbortController();
      for await (const _ of p.chat({ systemPrompt: "s", history: [], userMessage: "q" }, ac.signal, opts)) { /* drain */ }
      const args = readFileSync(argsFile, "utf8").split("\n");
      for (const a of CLAUDE_ISOLATION_ARGS) expect(args).toContain(a);
      expect(args.some((a) => a.startsWith("--tools="))).toBe(true);
      const cwd = readFileSync(cwdFile, "utf8").trim();
      expect(cwd).not.toBe(process.cwd());
      expect(path.basename(cwd)).toMatch(/^tk-claude-/);
    }
  });

  it("读图：只把本次图片复制进专用临时目录，提示词里是复制后的路径，结束后删除", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tk-claude-test-"));
    const uploads = path.join(dir, "uploads");
    mkdirSync(uploads);
    writeFileSync(path.join(uploads, "mine.png"), "png");
    writeFileSync(path.join(uploads, "someone-else.png"), "other");
    const stdinFile = path.join(dir, "stdin.txt");
    const cwdFile = path.join(dir, "cwd.txt");
    const p = newProvider({ FAKE_CLAUDE_STDIN_FILE: stdinFile, FAKE_CLAUDE_CWD_FILE: cwdFile });
    const ac = new AbortController();
    for await (const _ of p.chat({ systemPrompt: "s", history: [], userMessage: "q" }, ac.signal, { images: [path.join(uploads, "mine.png")] })) { /* drain */ }
    const cwd = readFileSync(cwdFile, "utf8").trim();
    expect(path.basename(cwd)).toMatch(/^tk-claude-img-/);
    const prompt = readFileSync(stdinFile, "utf8");
    expect(prompt).not.toContain(uploads);
    expect(prompt).toContain("1-mine.png");
    // 子进程退出后临时目录被删除(清理挂在 exit 上，给一个事件循环)
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(cwd)).toBe(false);
  });

  it("CLI 版本低于隔离参数所需版本时视为未就绪，并给出升级提示", async () => {
    const h = await newProvider({ FAKE_CLAUDE_VERSION: "2.0.5 (Claude Code)" }).isAvailable();
    expect(h.ok).toBe(false);
    expect(h.reason).toContain(MIN_CLAUDE_VERSION);
    expect(h.reason).toContain("claude update");
  });
});

describe("ClaudeCliProvider", () => {
  it("isAvailable returns ok with version", async () => {
    const h = await newProvider().isAvailable();
    expect(h.ok).toBe(true);
    expect(h.version).toBeTruthy();
  });

  it("isAvailable reports missing binary", async () => {
    const h = await new ClaudeCliProvider({ bin: "/nope/missing" }).isAvailable();
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/not found|ENOENT|missing/i);
  });

  it("streams tokens and ends with done", async () => {
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "abcdef" }), "hi");
    expect(r.text).toBe("abcdef");
    expect(r.done).toBe(true);
    expect(r.err).toBeNull();
  });

  it("yields error when CLI exits non-zero (auth failure)", async () => {
    const r = await collect(newProvider({ FAKE_CLAUDE_ERROR: "auth" }), "hi");
    expect(r.done).toBe(false);
    expect(r.err).toMatch(/login|auth/i);
  });

  it("aborts when signal fires (abort right after first token)", async () => {
    // Use a hang script so the binary stays alive past the first token,
    // then abort deterministically on first token rather than racing a
    // 5ms timer that may not fire on a loaded CI runner.
    const p = newProvider({ FAKE_CLAUDE_REPLY: "abcd-rest-of-reply-that-never-arrives", FAKE_CLAUDE_HANG: "1" });
    const ac = new AbortController();
    const iter = p.chat({ systemPrompt: "", history: [], userMessage: "go" }, ac.signal);
    let errored = false;
    let aborted = false;
    for await (const c of iter) {
      if (c.type === "token" && !aborted) { aborted = true; ac.abort(); }
      if (c.type === "error") errored = true;
    }
    expect(errored).toBe(true);
  });

  it("surfaces thinking start/end even when no thinking_delta text follows (signature-only case)", async () => {
    // Matches what Claude CLI currently emits for extended-thinking
    // models on this machine: a thinking block opens, gets only a
    // signature_delta (which the parser drops), then closes — no
    // raw reasoning text leaks. The UI still needs the open/close
    // signals so it can flip a "深度思考中" badge on and off; this
    // test guards that path.
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "answer", FAKE_CLAUDE_THINKING: "1" }), "hi");
    expect(r.thinkingStartedCount).toBe(1);
    expect(r.thinking).toBe("");
    expect(r.thinkingEnded).toBe(true);
    expect(r.text).toBe("answer");
    expect(r.done).toBe(true);
  });

  it("streams thinking text deltas before the answer (full extended-thinking case)", async () => {
    // Future-proof: when CLI surfaces raw thinking_delta text we
    // route it to the thinking lane (NOT the answer body) so the
    // user's bubble doesn't get polluted with reasoning prose.
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "result", FAKE_CLAUDE_THINKING: "let me reason about this..." }), "hi");
    expect(r.thinkingStartedCount).toBe(1);
    expect(r.thinking).toBe("let me reason about this...");
    expect(r.thinkingEnded).toBe(true);
    expect(r.text).toBe("result");
  });

  it("emits web citations from web_search_tool_result / WebFetch, deduped", async () => {
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "答案", FAKE_CLAUDE_WEB: "1" }), "hi");
    expect(r.text).toBe("答案");
    expect(r.done).toBe(true);
    // 三条命中里 https://a.example/1 重复一次 → 去重后 3 个 URL。
    expect(r.citations.map((c) => c.url)).toEqual(["https://a.example/1", "https://a.example/2", "https://b.example/doc"]);
    expect(r.citations[0].title).toBe("页面一");
  });

  // webTools 路径(orchestrator 的助手自答放开 WebSearch/WebFetch)在连续
  // 工具往返期间一个 text_delta 都没有:tool_use 不是 delta,tool_result 也不
  // 在 stream_event 里。原实现只在 text/thinking delta 上 arm() idle 计时器,
  // 于是一次正常的联网检索超过 90s 就被当成「CLI 挂了」SIGKILL,用户看到的是
  // 「没反应」而非「在搜」。这里 6 个工具帧跨约 0.9s、idle 窗口设 300ms:
  // 只有工具帧算 liveness 才跑得完,否则第 2 帧之前就 idle 超时。
  it("工具轮次(无 text token)也刷新 idle 窗口,不误杀", async () => {
    process.env.LLM_TIMEOUT_MS = "300";
    try {
      const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "搜完了", FAKE_CLAUDE_TOOLGAP: "6" }), "今天天气");
      expect(r.err).toBeNull();
      expect(r.done).toBe(true);
      expect(r.text).toBe("搜完了");
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
    }
  });

  it("idle timeout kills the child (no tokens received)", async () => {
    // LLM_TIMEOUT_MS is still honored as a legacy alias for the IDLE
    // window (see startIdleHardTimer); 50ms is short enough that the
    // hang script triggers the idle branch before the hard cap.
    process.env.LLM_TIMEOUT_MS = "50";
    try {
      const p = newProvider({ FAKE_CLAUDE_HANG: "1" });
      const ac = new AbortController();
      let err: string | null = null;
      for await (const c of p.chat({ systemPrompt: "", history: [], userMessage: "go" }, ac.signal)) {
        if (c.type === "error") err = c.message;
      }
      expect(err).toMatch(/idle for \d+ms/);
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
    }
  });
});
