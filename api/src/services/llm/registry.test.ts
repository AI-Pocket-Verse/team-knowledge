import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { setLlmProvider } from "../settings.js";
import { getProvider, invalidateProviderCache, probeAll } from "./registry.js";

describe("LLM registry", () => {
  beforeEach(async () => { await resetDb(); invalidateProviderCache(); });
  afterAll(async () => { await disconnectDb(); });

  it("defaults to claude when setting missing", async () => {
    const p = await getProvider();
    expect(p.name).toBe("claude");
  });

  it("returns codex once setting flips", async () => {
    await setLlmProvider("codex", "u");
    invalidateProviderCache();
    expect((await getProvider()).name).toBe("codex");
  });

  it("probeAll reports both providers", async () => {
    const r = await probeAll();
    expect(r).toHaveProperty("claude.ok");
    expect(r).toHaveProperty("codex.ok");
  });
});
