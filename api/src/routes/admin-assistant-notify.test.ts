import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { notify } = vi.hoisted(() => ({
  notify: vi.fn(async (_openId: string, _card: unknown) => ({ messageId: "om_x" })),
}));
vi.mock("../utils/feishuGateway.js", () => ({ feishuGateway: { notify } }));

import { buildServer } from "../server.js";
import { disconnectDb } from "../db.js";
import { resetDb, seedUser, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { invalidateProviderCache } from "../services/llm/registry.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../scripts/fake-claude.sh");

describe("POST /api/admin/assistant-notify", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    notify.mockClear();
    process.env.SUMMARY_PROVIDER = "main";
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "周报已生成,快去看看吧。";
  });
  afterAll(async () => { await disconnectDb(); });

  it("403 for non-admin", async () => {
    await seedUser({ ssoId: "u1", displayName: "U" });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/admin/assistant-notify",
      headers: { cookie: authCookie("u1") },
      payload: { userId: "x", intent: "y" },
    });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it("400 on missing fields", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/admin/assistant-notify",
      headers: { cookie: authCookie("admin") },
      payload: { intent: "y" }, // missing userId
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("admin sends an assistant notification to a target user", async () => {
    await seedAdmin();
    const target = await seedUser({ ssoId: "ou_target", displayName: "T" });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/admin/assistant-notify",
      headers: { cookie: authCookie("admin") },
      payload: { userId: target.id, intent: "提醒周报已生成", conversational: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().sent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toBe("ou_target");
    await app.close();
  });
});
