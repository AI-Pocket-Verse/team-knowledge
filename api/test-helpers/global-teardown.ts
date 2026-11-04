// Vitest globalSetup. Runs ONCE before the whole suite and returns a
// teardown that runs ONCE after every test file has finished.
//
// Why: setup-env.ts pins DATA_DIR=./data-test, and dozens of tests write
// real files there (uploads/, meeting-recordings/, meeting-tts/). Nothing
// ever cleaned them, so the dir grew without bound (800+ recordings, 400+
// uploads) — file-side state that bleeds across runs and slows the box.
// Deleting it per-test (in resetDb) would race tests that create files
// mid-test, so we clean exactly once, at the very end of the run.
//
// We deliberately do NOT touch prisma/test.db — that's row state managed
// by resetDb()/migrate-deploy, not file artifacts.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// Mirror setup-env.ts: DATA_DIR is "./data-test" relative to the api package
// cwd (where vitest runs). Resolve to an absolute path so the rm is unambiguous.
const DATA_TEST_DIR = resolve(process.cwd(), process.env.DATA_DIR ?? "./data-test");

async function cleanDataTest(): Promise<void> {
  // Guard: only ever delete a path that ends in "data-test", so a misconfigured
  // DATA_DIR can never nuke the real ./data dir or anything else.
  if (!DATA_TEST_DIR.endsWith("data-test")) return;
  await rm(DATA_TEST_DIR, { recursive: true, force: true });
}

export async function setup(): Promise<void> {
  // Start each run from a clean slate too, so a previously-aborted run's
  // artifacts don't accumulate.
  await cleanDataTest();
}

export async function teardown(): Promise<void> {
  await cleanDataTest();
}
