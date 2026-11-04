import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { resolveUserByOpenId } from "./resolveUserByOpenId.js";

describe("resolveUserByOpenId", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("returns an active member by ssoId (open_id)", async () => {
    const u = await seedUser({ ssoId: "ou_active", displayName: "A", isAdmin: true });
    expect(await resolveUserByOpenId("ou_active")).toEqual({ id: u.id, isAdmin: true, chatPreference: null });
  });

  it("null for an unknown open_id", async () => {
    expect(await resolveUserByOpenId("ou_missing")).toBeNull();
  });

  it("null for a deactivated member", async () => {
    await seedUser({ ssoId: "ou_off", displayName: "Off", isActive: false });
    expect(await resolveUserByOpenId("ou_off")).toBeNull();
  });

  it("null for a non-ou_ identifier", async () => {
    expect(await resolveUserByOpenId("on_app_open_id")).toBeNull();
  });
});
