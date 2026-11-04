import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../env.js";
import { getLlmProvider, setLlmProvider, enforceLlmProviderPolicy } from "../services/settings.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
import { invalidateProviderCache } from "../services/llm/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../scripts/fake-claude.sh");
const FAKE_CODEX  = path.resolve(__dirname, "../../scripts/fake-codex.sh");

describe("/api/admin/settings/llm-provider", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.CODEX_BIN = FAKE_CODEX;
  });
  afterAll(async () => { await disconnectDb(); });

  it("GET requires auth", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "GET", url: "/api/admin/settings/llm-provider" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("GET forbids non-admins", async () => {
    await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");
    const r = await app.inject({ method: "GET", url: "/api/admin/settings/llm-provider", headers: { cookie } });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it("GET returns current + both provider health", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "GET", url: "/api/admin/settings/llm-provider", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.current).toBe("claude");
    expect(body.available.claude.ok).toBe(true);
    expect(body.available.codex.ok).toBe(true);
    await app.close();
  });

  it("PATCH 400 on invalid provider name", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "PATCH", url: "/api/admin/settings/llm-provider", headers: { cookie }, payload: { provider: "openai" } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH 412 when target provider unavailable", async () => {
    await seedAdmin();
    process.env.CODEX_BIN = "/nope/missing";
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "PATCH", url: "/api/admin/settings/llm-provider", headers: { cookie }, payload: { provider: "codex" } });
    expect(r.statusCode).toBe(412);
    await app.close();
  });

  it("PATCH 200 + state flip on success", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "PATCH", url: "/api/admin/settings/llm-provider", headers: { cookie }, payload: { provider: "codex" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().current).toBe("codex");
    expect(r.json().codexAllowed).toBe(true);
    const r2 = await app.inject({ method: "GET", url: "/api/admin/settings/llm-provider", headers: { cookie } });
    expect(r2.json().current).toBe("codex");
    await app.close();
  });
});

describe("codex 引擎只允许本地模式", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.CODEX_BIN = FAKE_CODEX;
  });
  afterAll(async () => { env.WHOAMI_URL = undefined; await disconnectDb(); });

  it("多人模式(WHOAMI_URL 已配置)：切到 codex 返回 409 codex_not_allowed，库里不变", async () => {
    await seedAdmin();
    env.WHOAMI_URL = "http://sso.test/api/whoami";
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "PATCH", url: "/api/admin/settings/llm-provider", headers: { cookie }, payload: { provider: "codex" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("codex_not_allowed");
    expect(await getLlmProvider()).toBe("claude");
    const g = await app.inject({ method: "GET", url: "/api/admin/settings/llm-provider", headers: { cookie } });
    expect(g.json().codexAllowed).toBe(false);
    // claude 仍可切
    const ok = await app.inject({ method: "PATCH", url: "/api/admin/settings/llm-provider", headers: { cookie }, payload: { provider: "claude" } });
    expect(ok.statusCode).toBe(200);
    env.WHOAMI_URL = undefined;
    await app.close();
  });

  it("库里残留 codex：多人模式读到 claude，启动检查把它改回 claude 并写日志", async () => {
    await setLlmProvider("codex", "admin");
    expect(await getLlmProvider()).toBe("codex"); // 本地模式照旧
    env.WHOAMI_URL = "http://sso.test/api/whoami";
    expect(await getLlmProvider()).toBe("claude");
    const warn = vi.fn();
    await enforceLlmProviderPolicy({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    env.WHOAMI_URL = undefined;
    expect(await getLlmProvider()).toBe("claude"); // 已被写回
  });
});

// ─── 火山 STT credentials admin endpoints ──────────────
describe("/api/admin/settings/volc-stt", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.VOLC_STT_APP_ID;
    delete process.env.VOLC_STT_ACCESS_TOKEN;
  });
  afterAll(async () => { await disconnectDb(); });

  it("GET requires auth + forbids non-admins", async () => {
    const app = await buildServer(AUTH);
    const r401 = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt" });
    expect(r401.statusCode).toBe(401);
    await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const cookie = authCookie("u");
    const r403 = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    expect(r403.statusCode).toBe(403);
    await app.close();
  });

  it("GET returns configured=false when neither DB nor env are set", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ configured: false, appId: null, accessToken: null, apiKey: null, endpoint: null, resourceId: null, model: null, boostingTableId: null });
    await app.close();
  });

  it("PUT writes the row; GET 只返回掩码，不回传明文 accessToken", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const put = await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { appId: "my-app", accessToken: "supersecrettoken1234" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    const body = get.json();
    expect(body.configured).toBe(true);
    expect(body.appId).toBe("my-app");
    expect(body.accessToken).toBe("****1234");
    expect(JSON.stringify(body)).not.toContain("supersecrettoken1234");
    // 回传掩码 = 不修改；真实值仍在库里
    const put2 = await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { appId: "my-app", accessToken: body.accessToken, model: "m2" },
    });
    expect(put2.statusCode).toBe(200);
    const { getVolcSttCreds } = await import("../services/settings.js");
    expect((await getVolcSttCreds())?.accessToken).toBe("supersecrettoken1234");
    await app.close();
  });

  it("只配 API Key(新版控制台)即可保存；GET 掩码返回；清空 API Key 且无 App ID/Token → 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const put = await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { apiKey: "key-abcdef-123456" },
    });
    expect(put.statusCode).toBe(200);
    const body = (await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } })).json();
    expect(body).toMatchObject({ configured: true, apiKey: "****3456", appId: null, accessToken: null });
    const bad = await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { apiKey: "" },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("PUT persists boostingTableId; GET echoes it back", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { appId: "a", accessToken: "b", boostingTableId: "tbl-123" },
    });
    const get = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    expect(get.json().boostingTableId).toBe("tbl-123");
    await app.close();
  });

  it("PUT persists model (model_name); GET echoes it back", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { appId: "a", accessToken: "b", model: "smallmodel" },
    });
    const get = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    expect(get.json().model).toBe("smallmodel");
    await app.close();
  });

  it("PUT 400 on missing appId or accessToken", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { appId: "", accessToken: "x" },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE clears the row; subsequent GET reports configured=false", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-stt", headers: { cookie },
      payload: { appId: "a", accessToken: "b" },
    });
    const del = await app.inject({ method: "DELETE", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/admin/settings/volc-stt", headers: { cookie } });
    expect(get.json().configured).toBe(false);
    await app.close();
  });
});

describe("/api/admin/settings/volc-tts", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.VOLC_TTS_APP_ID;
    delete process.env.VOLC_TTS_ACCESS_TOKEN;
  });
  afterAll(async () => { await disconnectDb(); });

  it("PUT + GET roundtrip with voice + endpoint", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({
      method: "PUT", url: "/api/admin/settings/volc-tts", headers: { cookie },
      payload: { appId: "tts-app", accessToken: "tts-token-7777", voice: "BV001_streaming", endpoint: "wss://example.com" },
    });
    const get = await app.inject({ method: "GET", url: "/api/admin/settings/volc-tts", headers: { cookie } });
    const body = get.json();
    expect(body.configured).toBe(true);
    expect(body.appId).toBe("tts-app");
    expect(body.voice).toBe("BV001_streaming");
    expect(body.endpoint).toBe("wss://example.com");
    expect(body.accessToken).toBe("****7777");
    expect(JSON.stringify(body)).not.toContain("tts-token-7777");
    await app.close();
  });
});

describe("article-review 总开关", () => {
  beforeEach(async () => { await resetDb(); });

  it("admin 可读可写;默认 false", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const g1 = await app.inject({ method: "GET", url: "/api/admin/settings/article-review", headers: { cookie: authCookie("admin") } });
    expect(g1.json().enabled).toBe(false);
    const p = await app.inject({ method: "PATCH", url: "/api/admin/settings/article-review", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { enabled: true } });
    expect(p.statusCode).toBe(200);
    expect(p.json().enabled).toBe(true);
    await app.close();
  });

  it("默认 + 配置扫描间隔/静置阈值,越界自动夹紧", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const g = await app.inject({ method: "GET", url: "/api/admin/settings/article-review", headers: { cookie: authCookie("admin") } });
    expect(g.json()).toEqual({ enabled: false, scanIntervalSec: 120, idleMinutes: 10, minSeverity: "med", reminderEnabled: false, reminderHour: 10, reminderMinute: 0, reminderWeekdays: [1, 2, 3, 4, 5] });
    const p = await app.inject({
      method: "PATCH", url: "/api/admin/settings/article-review",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { scanIntervalSec: 5, idleMinutes: 30 }, // 间隔越界(<30)→ 夹到 30
    });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ scanIntervalSec: 30, idleMinutes: 30 });
    await app.close();
  });

  it("非 admin → 403", async () => {
    await prisma.user.create({ data: { ssoId: "ou_u", displayName: "U" } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/settings/article-review", headers: { cookie: authCookie("ou_u") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
