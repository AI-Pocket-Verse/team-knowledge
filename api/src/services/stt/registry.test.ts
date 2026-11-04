import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { getSttProvider, _resetSttProviderForTests } from "./registry.js";
import { setVolcSttCreds } from "../settings.js";

// ─── STT provider registry ───────────────────────────────
// Verifies the layered DB > env > stub resolution. The registry
// caches the resolved provider for 30s, so each test resets the
// cache between runs.

describe("stt provider registry", () => {
  const savedEnv = {
    VOLC_STT_APP_ID: process.env.VOLC_STT_APP_ID,
    VOLC_STT_ACCESS_TOKEN: process.env.VOLC_STT_ACCESS_TOKEN,
  };

  beforeEach(async () => {
    await resetDb();
    delete process.env.VOLC_STT_APP_ID;
    delete process.env.VOLC_STT_ACCESS_TOKEN;
    _resetSttProviderForTests();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetSttProviderForTests();
  });
  afterAll(async () => { await disconnectDb(); });

  it("returns the stub provider when neither DB nor env are set", async () => {
    const p = await getSttProvider();
    expect(p.name).toBe("stub");
  });

  it("returns the volc provider when env creds are set", async () => {
    process.env.VOLC_STT_APP_ID = "env-app";
    process.env.VOLC_STT_ACCESS_TOKEN = "env-token";
    const p = await getSttProvider();
    expect(p.name).toBe("volc");
  });

  it("returns the volc provider when DB creds are set", async () => {
    await setVolcSttCreds({ appId: "db-app", accessToken: "db-token" }, "admin");
    const p = await getSttProvider();
    expect(p.name).toBe("volc");
  });

  it("caches: a second call returns the same instance without re-reading creds", async () => {
    await setVolcSttCreds({ appId: "x", accessToken: "y" }, "admin");
    const first = await getSttProvider();
    // Clear DB row — second call within TTL must still get the cached volc
    // instance, not re-resolve to stub.
    await setVolcSttCreds(null, "admin");
    delete process.env.VOLC_STT_APP_ID;
    delete process.env.VOLC_STT_ACCESS_TOKEN;
    const second = await getSttProvider();
    expect(second).toBe(first);
    expect(second.name).toBe("volc");
  });

  it("after explicit cache reset, picks up the new creds state", async () => {
    await setVolcSttCreds({ appId: "x", accessToken: "y" }, "admin");
    const before = await getSttProvider();
    expect(before.name).toBe("volc");
    await setVolcSttCreds(null, "admin");
    _resetSttProviderForTests();
    const after = await getSttProvider();
    expect(after.name).toBe("stub");
  });

  it("concurrent callers during cold-start dedupe to one provider instance", async () => {
    process.env.VOLC_STT_APP_ID = "env-app";
    process.env.VOLC_STT_ACCESS_TOKEN = "env-token";
    const [a, b, c] = await Promise.all([
      getSttProvider(),
      getSttProvider(),
      getSttProvider(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("invalidation race: an inflight resolver does NOT overwrite the new cache after a mid-flight invalidate", async () => {
    // The race we're guarding against:
    //   1. Call A enters getSttProvider with empty cache.
    //   2. Admin rotates keys + calls invalidateSttProviderCache.
    //   3. Call B enters with the NEW creds; resolves + caches.
    //   4. Call A's IIFE (started before step 2) finishes — must
    //      NOT clobber the cache with the stale provider.
    // The generation counter fixes this: A captures gen BEFORE
    // its DB call, the invalidate bumps gen, A sees gen != myGen
    // on settle and skips the cache write.
    await setVolcSttCreds({ appId: "old", accessToken: "old-tok" }, "admin");
    const callA = getSttProvider();  // captures gen=N
    // Invalidate while A's inflight is still running.
    await setVolcSttCreds({ appId: "new", accessToken: "new-tok" }, "admin");
    _resetSttProviderForTests();  // bumps generation
    const callB = await getSttProvider();
    await callA;  // let the racing resolver settle
    // Now: the cache should still reflect call B's provider.
    // Anything new should see B's instance, not A's stale.
    const after = await getSttProvider();
    expect(after).toBe(callB);
  });
});
