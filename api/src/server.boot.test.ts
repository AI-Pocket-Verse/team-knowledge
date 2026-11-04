import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "./server.js";
import { disconnectDb } from "./db.js";
import { mockAuth } from "../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// A minimal pino-shaped logger INSTANCE (methods fastify's loggerInstance validation requires).
function stubLogger() {
  const noop = () => {};
  const l = { level: "info", fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop } as Record<string, unknown>;
  l.child = () => l;
  return l;
}

describe("buildServer — logger wiring (fastify 5)", () => {
  afterAll(async () => { await disconnectDb(); });

  // 回归:index.ts(真实 server)给 buildServer 传的是 pino【实例】。fastify 5 里传实例
  // 必须走 loggerInstance,若仍用 `logger: <实例>` 会在构造时抛 FST_ERR_LOG_INVALID_LOGGER,
  // 导致服务启动崩溃(而普通测试不传 logger,走布尔分支,漏掉这条路径)。
  it("boots (ready) when passed a logger INSTANCE — the real-server path", async () => {
    const app = await buildServer({ ...AUTH, logger: stubLogger() as never });
    await app.ready();
    expect(app.hasDecorator("log")).toBe(true);
    await app.close();
  });

  it("still boots with logger disabled (test path)", async () => {
    const app = await buildServer({ ...AUTH, logger: false });
    await app.ready();
    await app.close();
    expect(true).toBe(true);
  });
});
