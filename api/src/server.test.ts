import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("server", () => {
  it("responds 200 on /api/health", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
