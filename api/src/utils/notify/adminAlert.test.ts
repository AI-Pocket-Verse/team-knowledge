import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Mock the Feishu bot gateway so the alert never makes a real HTTP call.
const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("../feishuGateway.js", () => ({
  feishuGateway: { notify: (...a: unknown[]) => notify(...a) },
  FeishuGatewayError: class FeishuGatewayError extends Error {},
}));

import { disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { notifyAdminsOfNewUser } from "./adminAlert.js";

describe("notifyAdminsOfNewUser", () => {
  beforeEach(async () => {
    await resetDb();
    notify.mockReset();
    notify.mockResolvedValue({ messageId: "om_1" });
  });
  afterAll(async () => { await disconnectDb(); });

  it("pushes to every active ou_* admin, skipping non-ou_*, inactive, non-admin, and the newcomer", async () => {
    await seedUser({ ssoId: "ou_admin1", isAdmin: true });
    await seedUser({ ssoId: "ou_admin2", isAdmin: true });
    await seedUser({ ssoId: "legacy_admin", isAdmin: true });                 // not ou_* → skip
    await seedUser({ ssoId: "ou_admin_off", isAdmin: true, isActive: false }); // inactive → skip
    await seedUser({ ssoId: "ou_regular" });                                   // not admin → skip

    await notifyAdminsOfNewUser({ id: "new-user-id", displayName: "新人", email: "n@x.com" });

    expect(notify).toHaveBeenCalledTimes(2);
    const openIds = notify.mock.calls.map((c) => c[0]).sort();
    expect(openIds).toEqual(["ou_admin1", "ou_admin2"]);
    // The card carries the newcomer's name.
    expect(JSON.stringify(notify.mock.calls[0]![1])).toContain("新人");
  });

  it("excludes the newcomer when they are themselves a (bootstrap) admin", async () => {
    const self = await seedUser({ ssoId: "ou_self", isAdmin: true });
    await notifyAdminsOfNewUser({ id: self.id, displayName: "Self", email: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it("no-ops when no admin has a Feishu open_id (ou_*)", async () => {
    await seedUser({ ssoId: "legacy", isAdmin: true });
    await notifyAdminsOfNewUser({ id: "x", displayName: "X", email: null });
    expect(notify).not.toHaveBeenCalled();
  });
});
