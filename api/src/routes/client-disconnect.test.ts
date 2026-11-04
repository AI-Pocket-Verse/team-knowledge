// 真实 socket 下的客户端断连:POST 路由的请求流在处理器执行前已读完并关闭,
// app.inject 又没有真实的连接关闭语义,所以必须 listen + node:http 才能验证 abort 是否触发。
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const state = vi.hoisted(() => ({
  aborted: false,
  started: null as null | (() => void),
  calls: 0,
}));

// 阻塞型假运行器:收到 signal abort 才返回,记录是否被 abort。
function blockUntilAbort(signal: AbortSignal | undefined): Promise<void> {
  state.calls++;
  state.aborted = false;
  return new Promise<void>((resolve) => {
    state.started?.();
    if (signal?.aborted) { state.aborted = true; resolve(); return; }
    signal?.addEventListener("abort", () => { state.aborted = true; resolve(); });
  });
}

vi.mock("../services/chat/runChatTurn.js", async (orig) => {
  const actual = await orig<typeof import("../services/chat/runChatTurn.js")>();
  return {
    ...actual,
    runChatTurn: async (opts: { signal?: AbortSignal; onChunk: (c: unknown) => void }) => {
      opts.onChunk({ type: "cited", articleIds: [], refs: [] });
      await blockUntilAbort(opts.signal);
    },
  };
});
vi.mock("../services/chat/runGroupChatTurn.js", async (orig) => {
  const actual = await orig<typeof import("../services/chat/runGroupChatTurn.js")>();
  return { ...actual, runGroupChatTurn: async (opts: { signal?: AbortSignal }) => { await blockUntilAbort(opts.signal); } };
});
vi.mock("../services/article-review/review.js", async (orig) => {
  const actual = await orig<typeof import("../services/article-review/review.js")>();
  return {
    ...actual,
    fetchRelatedDocs: async () => [],
    callReviewLlm: async (_s: string, _u: string, signal?: AbortSignal) => { await blockUntilAbort(signal); return null; },
  };
});

import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
const TOKEN = "dev-internal-token-change-in-prod";

/** 真实 socket 发 POST;LLM 运行器启动后立刻销毁请求(模拟客户端/网关断连)。 */
async function postThenDisconnect(port: number, path: string, headers: Record<string, string>, payload: unknown): Promise<void> {
  const started = new Promise<void>((r) => { state.started = r; });
  const req = http.request(
    { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } },
    (res) => { res.on("data", () => {}); res.on("error", () => {}); },
  );
  req.on("error", () => {});
  req.end(JSON.stringify(payload));
  await started;
  req.destroy();
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
}

describe("POST 路由客户端提前断连 → abort LLM", () => {
  beforeEach(async () => { await resetDb(); state.aborted = false; state.started = null; state.calls = 0; });
  afterAll(async () => { await disconnectDb(); });

  it("chat/message 断连后 runChatTurn 的 signal 被 abort", async () => {
    await seedUser({ ssoId: "u" });
    const app = await buildServer(AUTH);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    await postThenDisconnect(port, "/api/chat/message", { cookie: authCookie("u") }, { content: "hi" });
    await waitFor(() => state.aborted);
    expect(state.aborted).toBe(true);
    await app.close();
  });

  it("internal/feishu/chat 断连后 signal 被 abort", async () => {
    await seedUser({ ssoId: "ou_member", displayName: "M" });
    const app = await buildServer(AUTH);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    await postThenDisconnect(port, "/api/internal/feishu/chat", { "x-internal-token": TOKEN }, { openId: "ou_member", text: "在吗" });
    await waitFor(() => state.aborted);
    expect(state.aborted).toBe(true);
    await app.close();
  });

  it("review/optimize 断连后 signal 被 abort,且 in-flight 锁释放(再次请求不是 409)", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await prisma.article.create({ data: { title: "T", contentMarkdown: "正文", roleId: role.id, createdById: admin.id } });
    const findings = [{ category: "logic", severity: "high", problem: "p", suggestion: "s", hash: "h1" }];
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus"='issues', "reviewFindings"=${JSON.stringify(findings)} WHERE "id"=${a.id}`;
    const app = await buildServer(AUTH);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    await postThenDisconnect(port, `/api/articles/${a.id}/review/optimize`, { cookie: authCookie("admin") }, {});
    await waitFor(() => state.aborted);
    expect(state.aborted).toBe(true);
    // 锁释放发生在 LLM 返回之后的 finally;等到再次请求不再 busy。
    let busy = true;
    for (let i = 0; i < 40 && busy; i++) {
      const state0 = state.calls;
      const p = postThenDisconnect(port, `/api/articles/${a.id}/review/optimize`, { cookie: authCookie("admin") }, {});
      await Promise.race([p, new Promise((r) => setTimeout(r, 200))]);
      busy = state.calls === state0; // 被 409 挡住时不会走到 LLM 运行器
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(busy).toBe(false);
    await app.close();
  });
});
