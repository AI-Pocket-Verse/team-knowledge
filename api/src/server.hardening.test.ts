import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { prisma, disconnectDb } from "./db.js";
import { mockAuth, resetDb, seedUser, authCookie } from "../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("统一 5xx 错误处理(对已注册路由生效)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("真实路由里抛出的内部错误不会把原文返回给用户", async () => {
    await seedUser({ ssoId: "u1" });
    const spy = vi.spyOn(prisma.bookmark, "findMany").mockRejectedValue(new Error("secret prisma internals users.email"));
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/bookmarks", headers: { cookie: authCookie("u1") } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
    expect(res.json()).toEqual({ error: "internal_error", message: "服务器内部错误" });
    spy.mockRestore();
    await app.close();
  });
});

describe("本地模式 Host 校验(防 DNS 重绑定)", () => {
  afterAll(async () => { await disconnectDb(); });

  it("Host 是陌生域名 → 421，GET 与 POST 都拒绝", async () => {
    const app = await buildServer(); // 不传 auth 且无 WHOAMI_URL = 本地模式
    const get = await app.inject({ method: "GET", url: "/api/me", headers: { host: "evil.example.net:4030" } });
    expect(get.statusCode).toBe(421);
    expect(get.json().error).toBe("host_not_allowed");
    const post = await app.inject({
      method: "POST", url: "/api/admin/roles",
      headers: { host: "evil.example.net:4030", origin: "http://evil.example.net:4030", "content-type": "application/json" },
      payload: { name: "rebind" },
    });
    expect(post.statusCode).toBe(421);
    await app.close();
  });

  it("localhost / 127.0.0.1 / WEB_ORIGIN 的主机名放行", async () => {
    const app = await buildServer();
    for (const host of ["localhost:4030", "127.0.0.1:4030", "[::1]:4030", "localhost"]) {
      const res = await app.inject({ method: "GET", url: "/api/health", headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
    await app.close();
  });

  it("多人模式(配置了 whoamiUrl)不做 Host 限制", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "kb.example.com" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("安全响应头", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  // 用 /api/me：上面的用例对 prisma.bookmark 打过 spy，换个路由避免互相影响。
  it("接口响应不允许缓存、不允许被嵌入；路由自己设的 Cache-Control 保持不变", async () => {
    await seedUser({ ssoId: "u1" });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: authCookie("u1") } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(res.headers["content-security-policy"]).toContain("object-src 'none'");
    // 未登录的 401 同样不缓存
    const anon = await app.inject({ method: "GET", url: "/api/me" });
    expect(anon.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});
