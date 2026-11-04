import { describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliProvider, codexExecArgs, codexSafeEnv, codexWorkDir, extractCodexWebCitations, extractCodexModel } from "./codex-cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(__dirname, "../../../scripts/fake-codex.sh");

function newProvider(env: Record<string, string> = {}): CodexCliProvider {
  return new CodexCliProvider({ bin: FAKE, env: { ...process.env, ...env } });
}

describe("extractCodexModel(尽力抓模型名)", () => {
  it("从事件里递归找到 model 字符串", () => {
    expect(extractCodexModel('{"type":"thread.started","model":"gpt-5-codex"}')).toBe("gpt-5-codex");
    expect(extractCodexModel('{"type":"x"}\n{"type":"turn.completed","item":{"model":"o4-mini"}}')).toBe("o4-mini");
  });
  it("不带 model / 非 JSON 噪音 → null", () => {
    expect(extractCodexModel('{"type":"turn.completed","usage":{"in":1}}')).toBeNull();
    expect(extractCodexModel("not json\n\n")).toBeNull();
    expect(extractCodexModel("")).toBeNull();
  });
});

describe("CodexCliProvider", () => {
  it("isAvailable ok", async () => {
    const h = await newProvider().isAvailable();
    expect(h.ok).toBe(true);
  });

  it("isAvailable not ok when bin missing", async () => {
    const h = await new CodexCliProvider({ bin: "/nope/x" }).isAvailable();
    expect(h.ok).toBe(false);
  });

  it("streams a single token + done", async () => {
    const out: string[] = [];
    let done = false;
    const ac = new AbortController();
    for await (const c of newProvider({ FAKE_CODEX_REPLY: "hello-codex" }).chat({
      systemPrompt: "", history: [], userMessage: "?",
    }, ac.signal)) {
      if (c.type === "token") out.push(c.text);
      if (c.type === "done") done = true;
    }
    expect(out.join("")).toBe("hello-codex");
    expect(done).toBe(true);
  });

  it("errors on auth failure", async () => {
    let err: string | null = null;
    const ac = new AbortController();
    for await (const c of newProvider({ FAKE_CODEX_ERROR: "auth" }).chat({
      systemPrompt: "", history: [], userMessage: "?",
    }, ac.signal)) {
      if (c.type === "error") err = c.message;
    }
    expect(err).toMatch(/auth/i);
  });

  it("codexExecArgs:忽略用户配置、只读沙箱；webTools 时开联网检索(-c tools.web_search=true)", () => {
    const base = ["exec", "--json", "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check"];
    expect(codexExecArgs()).toEqual(base);
    expect(codexExecArgs({ webTools: true })).toEqual([...base, "-c", "tools.web_search=true"]);
    expect(codexExecArgs({ webTools: true, images: ["/a.png"] })).toEqual([...base, "-c", "tools.web_search=true", "-i", "/a.png"]);
    expect(codexExecArgs({ images: ["/a.png", "/b.png"] })).toEqual([...base, "-i", "/a.png", "-i", "/b.png"]);
    expect(codexExecArgs({ model: "gpt-6.1-sol", webTools: true })).toEqual([...base, "-m", "gpt-6.1-sol", "-c", "tools.web_search=true"]);
  });

  it("codexSafeEnv:只保留运行必需变量，不带密钥", () => {
    const out = codexSafeEnv({
      PATH: "/usr/bin", HOME: "/home/kb", LANG: "zh_CN.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://p:1",
      INTERNAL_API_TOKEN: "secret", OPENAI_API_KEY: "sk-x", DATABASE_URL: "file:x", VOLC_STT_API_KEY: "k",
    });
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/kb", LANG: "zh_CN.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://p:1" });
  });

  it("默认(未显式传 env)时子进程在空临时目录里运行，且看不到服务密钥", async () => {
    // 用一个假 codex 打印 cwd 与环境，验证真实 spawn 调用链。
    process.env.INTERNAL_API_TOKEN_PROBE = "leak-me";
    const probe = path.resolve(__dirname, "../../../scripts/fake-codex-env.sh");
    const ac = new AbortController();
    let text = "";
    for await (const c of new CodexCliProvider({ bin: probe }).chat({ systemPrompt: "", history: [], userMessage: "?" }, ac.signal)) {
      if (c.type === "token") text += c.text;
    }
    delete process.env.INTERNAL_API_TOKEN_PROBE;
    expect(text).toMatch(/cwd=.*tk-codex-/);
    expect(text).not.toMatch(/leak-me/);
    expect(text).toMatch(/args=.*--sandbox read-only/);
  });

  it("extractCodexWebCitations:非 http(s) 协议的 URL 一律丢弃", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "javascript:alert(1)" } }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "file:///etc/passwd" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "see javascript:alert(1) and data:text/html,x" } }),
    ].join("\n");
    expect(extractCodexWebCitations(stdout)).toEqual([]);
  });

  it("extractCodexWebCitations:抓取页 URL 计为出处,纯搜索词不计,去重", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "AI news July 6 2026", action: { type: "search" } } }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "https://example.com/a", action: { type: "other" } } }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "https://example.com/a", action: { type: "other" } } }), // 重复
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "…" } }),
      "非 JSON 噪声行",
    ].join("\n");
    expect(extractCodexWebCitations(stdout)).toEqual([{ url: "https://example.com/a" }]);
  });

  it("extractCodexWebCitations:从答案文本抽模型引用的 URL(当前 codex 只在 agent_message 带来源),去重+去尾标点", () => {
    const stdout = [
      // 当前 codex 版本:web_search item 只带搜索词,不带结果 URL
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "AI news July 7 2026", action: { type: "search" } } }),
      // 真正的来源 URL 在最终答案里(卡片 JSON / markdown 链接),含中英文尾标点与重复
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "见 [报道](https://a.com/x)。又见 https://b.com/y,以及 \"https://a.com/x\"。" } }),
    ].join("\n");
    expect(extractCodexWebCitations(stdout)).toEqual([{ url: "https://a.com/x" }, { url: "https://b.com/y" }]);
  });
});

// 系统清理临时目录后，下一次调用要能拿到一个存在的工作目录。
describe("codexWorkDir", () => {
  it("缓存的临时目录被删掉后重新创建", () => {
    const first = codexWorkDir();
    expect(existsSync(first)).toBe(true);
    rmSync(first, { recursive: true });
    const second = codexWorkDir();
    expect(existsSync(second)).toBe(true);
  });
});
