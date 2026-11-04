import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { disconnectDb } from "./db.js";
import { mockAuth } from "../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("CSRF hook", () => {
  afterAll(async () => { await disconnectDb(); });

  it("blocks POST with form Content-Type", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST",
      url: "/api/bookmarks",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "articleId=abc",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf");
    await app.close();
  });

  it("allows POST with application/json (CSRF passes; auth then 401s)", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST",
      url: "/api/bookmarks",
      headers: { "content-type": "application/json" },
      payload: { articleId: "abc" },
    });
    // Returns 401 (not 403), proving the CSRF hook passed and auth ran.
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("allows GET without any special header", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a cross-origin bodyless POST (no token, forged Origin)", async () => {
    const app = await buildServer(AUTH);
    // Bodyless mutation (no content-type) that would otherwise pass the
    // content-type allowance — the Origin check must catch it.
    const res = await app.inject({
      method: "POST",
      url: "/api/articles/abc/edit-lock",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf");
    await app.close();
  });

  it("allows a same-origin (WEB_ORIGIN) bodyless POST through CSRF (auth then 401s)", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST",
      url: "/api/articles/abc/edit-lock",
      headers: { origin: "http://localhost:5030" },
    });
    // Not 403 — proves the Origin check passed; auth then rejects unauthenticated.
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it("allows a gateway-proxied bodyless POST (Origin matches X-Forwarded-Host, not WEB_ORIGIN)", async () => {
    const app = await buildServer(AUTH);
    // Behind a reverse proxy (http://localhost:8080) the browser Origin is the
    // gateway, but the upstream req.host is 127.0.0.1:<port> and WEB_ORIGIN is
    // :5030 — only the forwarded host makes them match. Regression guard for
    // the "every mutation 403s behind the proxy" bug.
    const res = await app.inject({
      method: "POST",
      url: "/api/articles/abc/edit-lock",
      headers: {
        origin: "http://localhost:8080",
        "x-forwarded-host": "localhost:8080",
        "x-forwarded-proto": "http",
      },
    });
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it("allows a JSON POST carrying the matching Origin", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST",
      url: "/api/bookmarks",
      headers: { "content-type": "application/json", origin: "http://localhost:5030" },
      payload: { articleId: "abc" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
