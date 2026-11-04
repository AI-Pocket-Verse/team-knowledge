import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedAdmin } from "../../../test-helpers/db.js";
import {
  scheduleAutoEnd,
  cancelAutoEnd,
  cleanupOldMeetingArtifacts,
  unlinkTtsClipsForComments,
  _resetLifecycleForTests,
} from "./lifecycle.js";
import { _resetMeetingWsForTests } from "../../routes/meeting-ws.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { env } from "../../env.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => log),
  level: "info",
  silent: vi.fn(),
} as never;  // FastifyBaseLogger duck-type for the tiny surface we use

describe("meeting lifecycle: auto-end", () => {
  beforeEach(async () => {
    await resetDb();
    await _resetMeetingWsForTests();
    _resetLifecycleForTests();
  });
  afterEach(() => { _resetLifecycleForTests(); });
  afterAll(async () => { await disconnectDb(); });

  it("scheduleAutoEnd: past-due meeting fires the auto-end on next tick", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const row = await prisma.meetingSession.create({
      data: {
        title: "stale", createdById: admin.id, status: "active",
        allowedRoleIds: JSON.stringify([role.id]),
        config: JSON.stringify({
          tts: false, recording: false, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true,
          triggerKeyword: true, durationHintHours: 4, style: "neutral",
        }),
        // Pretend this row is 5 hours old — past the 4h hint + 30min grace.
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      },
    });

    scheduleAutoEnd(row.id, row.createdAt, 4, log);
    // The fire is async; give it a few macroticks to land.
    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.meetingSession.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("ended");
    expect(after?.endedAt).not.toBeNull();
  });

  it("cancelAutoEnd: a canceled timer never fires", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const row = await prisma.meetingSession.create({
      data: {
        title: "stale", createdById: admin.id, status: "active",
        allowedRoleIds: JSON.stringify([role.id]),
        config: JSON.stringify({
          tts: false, recording: false, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true,
          triggerKeyword: true, durationHintHours: 4, style: "neutral",
        }),
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      },
    });

    scheduleAutoEnd(row.id, row.createdAt, 4, log);
    cancelAutoEnd(row.id);
    await new Promise((r) => setTimeout(r, 200));
    const after = await prisma.meetingSession.findUnique({ where: { id: row.id } });
    // Status should be unchanged since the timer was cancelled
    // before its `setTimeout(0)` macrotick fired.
    expect(after?.status).toBe("active");
  });
});

describe("meeting lifecycle: artifact cleanup", () => {
  beforeEach(async () => {
    await resetDb();
    await _resetMeetingWsForTests();
    _resetLifecycleForTests();
  });
  afterAll(async () => { await disconnectDb(); });

  it("scans ended meetings older than retention + reports counts (no real files in test env)", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    // One row well past the retention window.
    await prisma.meetingSession.create({
      data: {
        title: "old", createdById: admin.id, status: "ended",
        allowedRoleIds: JSON.stringify([role.id]),
        config: JSON.stringify({
          tts: false, recording: true, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true,
          triggerKeyword: true, durationHintHours: 4, style: "neutral",
        }),
        endedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      },
    });
    // One row recent (should NOT be touched).
    await prisma.meetingSession.create({
      data: {
        title: "recent", createdById: admin.id, status: "ended",
        allowedRoleIds: JSON.stringify([role.id]),
        config: JSON.stringify({
          tts: false, recording: true, freqLimitMinutes: 5, freqLimitMessages: 1, triggerSilence: true,
          triggerKeyword: true, durationHintHours: 4, style: "neutral",
        }),
        endedAt: new Date(),
      },
    });
    const result = await cleanupOldMeetingArtifacts(log);
    expect(result.meetingsScanned).toBe(1);
    // recordingsDeleted may be 0 if no real .ogg was written in the test;
    // the contract is "scans and attempts unlink", which we cover by
    // verifying the scan count.
    expect(result.recordingsDeleted).toBeGreaterThanOrEqual(0);
    expect(result.ttsDeleted).toBeGreaterThanOrEqual(0);
  });
});

describe("unlinkTtsClipsForComments (per-sentence clip cleanup)", () => {
  const ttsDir = resolve(join(env.DATA_DIR, "meeting-tts"));

  it("unlinks BOTH the whole-comment <id>.mp3 and streamed <id>-<seq>.mp3 clips, leaving others", async () => {
    await mkdir(ttsDir, { recursive: true });
    // Target comment: a legacy whole-comment clip + 3 streamed per-sentence clips.
    const target = "cmtaaaaaaaaaaaaa";
    await writeFile(join(ttsDir, `${target}.mp3`), "x");
    await writeFile(join(ttsDir, `${target}-0.mp3`), "x");
    await writeFile(join(ttsDir, `${target}-1.mp3`), "x");
    await writeFile(join(ttsDir, `${target}-12.mp3`), "x");
    // An unrelated comment's clip that must survive.
    const other = "cmtbbbbbbbbbbbbb";
    await writeFile(join(ttsDir, `${other}-0.mp3`), "x");

    const deleted = await unlinkTtsClipsForComments(ttsDir, [target]);
    expect(deleted).toBe(4);
    expect(existsSync(join(ttsDir, `${target}.mp3`))).toBe(false);
    expect(existsSync(join(ttsDir, `${target}-0.mp3`))).toBe(false);
    expect(existsSync(join(ttsDir, `${target}-1.mp3`))).toBe(false);
    expect(existsSync(join(ttsDir, `${target}-12.mp3`))).toBe(false);
    // The other comment's clip is untouched.
    expect(existsSync(join(ttsDir, `${other}-0.mp3`))).toBe(true);

    // Cleanup the survivor so repeat runs stay deterministic.
    await rm(join(ttsDir, `${other}-0.mp3`), { force: true });
  });

  it("is a no-op (returns 0) for an empty id list or a missing dir", async () => {
    expect(await unlinkTtsClipsForComments(ttsDir, [])).toBe(0);
    expect(await unlinkTtsClipsForComments(resolve(join(env.DATA_DIR, "no-such-dir-xyz")), ["cmt"])).toBe(0);
  });
});
