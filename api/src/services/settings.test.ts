import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, disconnectDb } from "../db.js";
import { resetDb } from "../../test-helpers/db.js";
import {
  getSetting, setSetting, getLlmProvider, setLlmProvider,
  getVolcSttCreds, setVolcSttCreds,
  getVolcTtsCreds, setVolcTtsCreds,
} from "./settings.js";

describe("settings service", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("getSetting returns default when row missing", async () => {
    expect(await getSetting("nope", "fallback")).toBe("fallback");
  });

  it("setSetting writes JSON-encoded value", async () => {
    await setSetting("k", { a: 1 }, "user-1");
    const row = await prisma.setting.findUnique({ where: { key: "k" } });
    expect(row?.value).toBe(JSON.stringify({ a: 1 }));
    expect(row?.updatedBy).toBe("user-1");
  });

  it("getLlmProvider defaults to 'claude'", async () => {
    expect(await getLlmProvider()).toBe("claude");
  });

  it("setLlmProvider rejects bad name", async () => {
    await expect(setLlmProvider("openai" as never, "u")).rejects.toThrow();
  });

  it("setLlmProvider stores and roundtrips", async () => {
    await setLlmProvider("codex", "u");
    expect(await getLlmProvider()).toBe("codex");
  });
});

// ─── 火山 STT/TTS credentials ─────────────────────────
describe("volc credentials", () => {
  // Save and restore env so tests don't pollute the process env
  // for the rest of the suite (other tests assert specific env
  // behavior).
  const savedEnv = {
    VOLC_STT_APP_ID: process.env.VOLC_STT_APP_ID,
    VOLC_STT_ACCESS_TOKEN: process.env.VOLC_STT_ACCESS_TOKEN,
    VOLC_STT_ENDPOINT: process.env.VOLC_STT_ENDPOINT,
    VOLC_TTS_APP_ID: process.env.VOLC_TTS_APP_ID,
    VOLC_TTS_ACCESS_TOKEN: process.env.VOLC_TTS_ACCESS_TOKEN,
  };
  beforeEach(async () => {
    await resetDb();
    delete process.env.VOLC_STT_APP_ID;
    delete process.env.VOLC_STT_ACCESS_TOKEN;
    delete process.env.VOLC_STT_ENDPOINT;
    delete process.env.VOLC_TTS_APP_ID;
    delete process.env.VOLC_TTS_ACCESS_TOKEN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("getVolcSttCreds returns null when neither DB nor env are set", async () => {
    expect(await getVolcSttCreds()).toBeNull();
  });

  it("getVolcSttCreds reads from env when DB row missing", async () => {
    process.env.VOLC_STT_APP_ID = "env-app";
    process.env.VOLC_STT_ACCESS_TOKEN = "env-token";
    const creds = await getVolcSttCreds();
    expect(creds).toEqual({ appId: "env-app", accessToken: "env-token", endpoint: undefined, resourceId: undefined });
  });

  it("getVolcSttCreds prefers DB row over env", async () => {
    process.env.VOLC_STT_APP_ID = "env-app";
    process.env.VOLC_STT_ACCESS_TOKEN = "env-token";
    await setVolcSttCreds({ appId: "db-app", accessToken: "db-token" }, "admin");
    const creds = await getVolcSttCreds();
    expect(creds?.appId).toBe("db-app");
    expect(creds?.accessToken).toBe("db-token");
  });

  it("setVolcSttCreds rejects missing appId/accessToken", async () => {
    await expect(setVolcSttCreds({ appId: "", accessToken: "x" }, "u")).rejects.toThrow();
    await expect(setVolcSttCreds({ appId: "x", accessToken: "" }, "u")).rejects.toThrow();
  });

  it("setVolcSttCreds(null) clears the row + reverts to env fallback", async () => {
    process.env.VOLC_STT_APP_ID = "env-app";
    process.env.VOLC_STT_ACCESS_TOKEN = "env-token";
    await setVolcSttCreds({ appId: "db-app", accessToken: "db-token" }, "u");
    await setVolcSttCreds(null, "u");
    const creds = await getVolcSttCreds();
    expect(creds?.appId).toBe("env-app");  // fell back to env
  });

  it("getVolcTtsCreds: same DB > env > null layering", async () => {
    expect(await getVolcTtsCreds()).toBeNull();
    process.env.VOLC_TTS_APP_ID = "env-tts-app";
    process.env.VOLC_TTS_ACCESS_TOKEN = "env-tts-token";
    expect((await getVolcTtsCreds())?.appId).toBe("env-tts-app");
    await setVolcTtsCreds({ appId: "db-tts", accessToken: "db-tts-tok", voice: "v01" }, "u");
    const merged = await getVolcTtsCreds();
    expect(merged?.appId).toBe("db-tts");
    expect(merged?.voice).toBe("v01");
  });
});
