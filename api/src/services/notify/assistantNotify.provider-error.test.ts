import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// feishuGateway.notify is mocked so no real outbound card is sent.
const { notify } = vi.hoisted(() => ({
  notify: vi.fn(async (_openId: string, _card: unknown) => ({ messageId: "om_x" })),
}));
vi.mock("../../utils/feishuGateway.js", () => ({ feishuGateway: { notify } }));

// The LLM provider iterator THROWS (spawn failure / abort / rate-limit-as-throw).
// notifyUserViaassistant must degrade to the intent text and still resolve — its
// best-effort contract says it never bubbles an authoring error to the caller.
vi.mock("../llm/registry.js", () => ({
  getProvider: vi.fn(async () => ({
    // eslint-disable-next-line require-yield
    chat: async function* () { throw new Error("provider boom"); },
  })),
  invalidateProviderCache: vi.fn(),
}));

import { disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { notifyUserViaAssistant } from "./assistantNotify.js";

const log = { info() {}, warn() {}, error() {} } as never;

describe("notifyUserViaAssistant — provider throws", () => {
  beforeEach(async () => {
    await resetDb();
    notify.mockClear();
  });
  afterAll(async () => { await disconnectDb(); });

  it("degrades to the intent text and still sends (never throws)", async () => {
    const u = await seedUser({ ssoId: "ou_boom", displayName: "B" });
    const r = await notifyUserViaAssistant({ userId: u.id, intent: "提醒他周报已生成", log });
    expect(r.sent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    // The card carries the fallback intent text (LLM authoring threw).
    expect(JSON.stringify(notify.mock.calls[0]?.[1])).toContain("提醒他周报已生成");
  });
});
