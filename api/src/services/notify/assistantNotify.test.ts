import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

// vi.hoisted so the mock factory (hoisted to top) can see the spy. Typed params
// so notify.mock.calls[0][0]/[1] type-check.
const { notify } = vi.hoisted(() => ({
  notify: vi.fn(async (_openId: string, _card: unknown) => ({ messageId: "om_x" })),
}));
vi.mock("../../utils/feishuGateway.js", () => ({ feishuGateway: { notify } }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { invalidateProviderCache } from "../llm/registry.js";
import { notifyUserViaAssistant } from "./assistantNotify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../../scripts/fake-claude.sh");
const log = { info() {}, warn() {}, error() {} } as never;

describe("notifyUserViaAssistant", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    notify.mockClear();
    process.env.SUMMARY_PROVIDER = "main"; // 用主 provider(fake-claude)
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "你有 3 条新评论待查看。";
  });
  afterAll(async () => { await disconnectDb(); });

  it("sends an assistant-authored card to the user (non-conversational by default)", async () => {
    const u = await seedUser({ ssoId: "ou_x", displayName: "X" });
    const r = await notifyUserViaAssistant({ userId: u.id, intent: "提醒用户有新评论", log });
    expect(r.sent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toBe("ou_x");
    expect(JSON.stringify(notify.mock.calls[0]?.[1])).toContain("你有 3 条新评论");
    expect(await prisma.chatMessage.count()).toBe(0); // 纯推送不落库
  });

  it("conversational=true appends an assistant message to the shared conversation", async () => {
    const u = await seedUser({ ssoId: "ou_y", displayName: "Y" });
    await notifyUserViaAssistant({ userId: u.id, intent: "提醒", conversational: true, log });
    const msgs = await prisma.chatMessage.findMany();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect(msgs[0]?.source).toBe("notify");
  });

  it("skips users without a feishu open_id", async () => {
    const u = await seedUser({ ssoId: "internal-not-ou", displayName: "Z" });
    const r = await notifyUserViaAssistant({ userId: u.id, intent: "x", log });
    expect(r.sent).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips inactive users", async () => {
    const u = await seedUser({ ssoId: "ou_off", displayName: "Off", isActive: false });
    const r = await notifyUserViaAssistant({ userId: u.id, intent: "x", log });
    expect(r.sent).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
