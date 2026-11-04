import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { getTtsProvider, _resetTtsProviderForTests } from "./registry.js";
import { setVolcTtsCreds } from "../settings.js";

// ─── TTS provider registry ───────────────────────────
// Mirrors services/stt/registry.test.ts. Verifies the layered
// DB > env > stub resolution + the 30s cache.

describe("tts provider registry", () => {
  const savedEnv = {
    VOLC_TTS_APP_ID: process.env.VOLC_TTS_APP_ID,
    VOLC_TTS_ACCESS_TOKEN: process.env.VOLC_TTS_ACCESS_TOKEN,
  };
  beforeEach(async () => {
    await resetDb();
    delete process.env.VOLC_TTS_APP_ID;
    delete process.env.VOLC_TTS_ACCESS_TOKEN;
    _resetTtsProviderForTests();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetTtsProviderForTests();
  });
  afterAll(async () => { await disconnectDb(); });

  it("returns the stub provider when neither DB nor env are set", async () => {
    const p = await getTtsProvider();
    expect(p.name).toBe("stub");
  });

  it("returns the volc provider when DB creds are set", async () => {
    await setVolcTtsCreds({ appId: "db-tts", accessToken: "db-tok" }, "admin");
    const p = await getTtsProvider();
    expect(p.name).toBe("volc");
  });

  it("invalidate forces re-read on next call", async () => {
    await setVolcTtsCreds({ appId: "a", accessToken: "b" }, "admin");
    expect((await getTtsProvider()).name).toBe("volc");
    await setVolcTtsCreds(null, "admin");
    _resetTtsProviderForTests();
    expect((await getTtsProvider()).name).toBe("stub");
  });
});
