import type { FastifyBaseLogger } from "fastify";
import { unlink, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { meetingConfigSchema } from "../../schemas/meeting.js";
import { existsSync } from "node:fs";
import { shutdownMeetingChannel, safeRecordingPath, finalizeWavSizes } from "../../routes/meeting-ws.js";
import { generateMeetingSummary } from "./summary.js";

// ─── Meeting lifecycle hardening ─────────────
//
// Two concerns this module handles:
//
//   1. Abandoned meetings stay `status: "active"` forever if the
//      host closes their browser without pressing 结束会议. Per
//      the single-active-per-admin rule, that locks the admin out
//      from creating any new meeting. SessionState also leaks
//      in memory. Fix: an auto-end timer scheduled at create
//      time + a startup reaper for stale-active rows.
//
//   2. Recording .ogg files and TTS .mp3 files accumulate
//      forever — no rotation, no TTL. Disk fills silently.
//      Fix: a startup-time + daily artifact cleanup that
//      deletes files for meetings ended more than
//      ARTIFACT_RETENTION_DAYS ago.
//
// Server.ts calls `installMeetingLifecycle(app.log)` once at
// startup; it both reaps stale rows and schedules the daily
// cleanup interval.

// ─── TTS clip cleanup ─────────────────────────────────────
// Unlink every on-disk TTS mp3 belonging to the given comment ids: both the
// whole-comment `<id>.mp3` and the streamed per-sentence `<id>-<seq>.mp3`
// clips (the latter leave MeetingComment.ttsAudioUrl null, so a url-gated
// sweep never reaped them → unbounded disk growth). Readdir once and match
// each filename against the id set so a meeting with N comments is a single
// directory scan. Best-effort: a missing dir or unlink race is swallowed.
// Returns the count actually unlinked. Shared by the daily artifact cleanup
// and purgeMeeting (routes/meeting.ts).
export async function unlinkTtsClipsForComments(ttsDir: string, commentIds: string[]): Promise<number> {
  if (commentIds.length === 0) return 0;
  const ids = new Set(commentIds);
  let files: string[];
  try {
    files = await readdir(ttsDir);
  } catch {
    return 0; // dir doesn't exist yet (no TTS ever written) — nothing to clean
  }
  let deleted = 0;
  for (const f of files) {
    const m = /^([a-z0-9]+)(?:-\d+)?\.mp3$/i.exec(f);
    if (!m || !ids.has(m[1]!)) continue;
    try { await unlink(join(ttsDir, f)); deleted++; } catch { /* race / already gone */ }
  }
  return deleted;
}

// ─── Auto-end ────────────────────────────────────────────
// Active timers keyed by sessionId. setTimeout returns are
// captured so DELETE / process shutdown can cancel them.
const autoEndTimers = new Map<string, NodeJS.Timeout>();

// Grace beyond the host's `durationHintHours` before we force
// the meeting closed. Buffers for clock skew + "I went 5 minutes
// over my 2-hour estimate" without auto-killing.
const AUTO_END_GRACE_MS = 30 * 60 * 1000;

// Hard cap: even if durationHintHours says 12, never let a
// meeting run past this. Defends against config drift / abuse.
const AUTO_END_MAX_MS = 24 * 60 * 60 * 1000;

export function scheduleAutoEnd(
  sessionId: string,
  createdAt: Date,
  durationHintHours: number,
  log: FastifyBaseLogger,
): void {
  cancelAutoEnd(sessionId);
  const cap = Math.min(durationHintHours * 60 * 60 * 1000 + AUTO_END_GRACE_MS, AUTO_END_MAX_MS);
  const endsAt = createdAt.getTime() + cap;
  const delay = Math.max(0, endsAt - Date.now());
  const timer = setTimeout(() => {
    void fireAutoEnd(sessionId, log);
  }, delay);
  // Don't keep the event loop alive on this timer alone — the
  // HTTP server is the lifetime anchor. Tests benefit too.
  timer.unref?.();
  autoEndTimers.set(sessionId, timer);
}

export function cancelAutoEnd(sessionId: string): void {
  const existing = autoEndTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  autoEndTimers.delete(sessionId);
}

async function fireAutoEnd(sessionId: string, log: FastifyBaseLogger): Promise<void> {
  autoEndTimers.delete(sessionId);
  try {
    const row = await prisma.meetingSession.findUnique({ where: { id: sessionId } });
    if (!row) return;
    if (row.status !== "active") return;
    log.warn({ event: "meeting.auto_ending", id: sessionId, createdAt: row.createdAt }, "force-ending abandoned meeting");
    const { recordingUrl } = await shutdownMeetingChannel(sessionId);
    await prisma.meetingSession.update({
      where: { id: sessionId },
      data: {
        status: "ended",
        endedAt: new Date(),
        recordingUrl: recordingUrl ?? row.recordingUrl,
      },
    });
    // Same fire-and-forget summary as the manual DELETE path.
    void generateMeetingSummary(sessionId, log).catch((err) => {
      log.error({ event: "meeting.auto_end.summary_failed", id: sessionId, err: (err as Error).message }, "summary after auto-end failed");
    });
  } catch (err) {
    log.error({ event: "meeting.auto_end_failed", id: sessionId, err: (err as Error).message }, "auto-end fire failed");
  }
}

// Test helper: clears every pending auto-end timer so a test's
// session isn't kept alive by a stale timer leaking into the
// next test's setup.
export function _resetLifecycleForTests(): void {
  for (const t of autoEndTimers.values()) clearTimeout(t);
  autoEndTimers.clear();
}

// ─── Startup reaper ───────────────────────────────────────
// Run once on boot. For every row still in `status: "active"`:
//   - if it's past its hint+grace already → fire auto-end now
//   - otherwise reschedule the timer in-memory
async function reapStaleActiveMeetings(log: FastifyBaseLogger): Promise<void> {
  const active = await prisma.meetingSession.findMany({ where: { status: "active" } });
  for (const row of active) {
    let hours = 4;
    try {
      const parsed = meetingConfigSchema.parse(JSON.parse(row.config));
      hours = parsed.durationHintHours;
    } catch { /* default 4 */ }
    scheduleAutoEnd(row.id, row.createdAt, hours, log);
    // The process died mid-recording for any row still "active" on boot, so its
    // .wav RIFF/data sizes were never patched (finalize runs only in the live
    // shutdown path). Finalize the orphaned file now against its on-disk path so
    // the recording plays back with a correct duration even before this meeting
    // is auto-ended. Best-effort: a missing file / locked handle is swallowed.
    try {
      const path = safeRecordingPath(row.id);
      if (path && existsSync(path)) await finalizeWavSizes(path);
    } catch (err) {
      log.warn({ event: "meeting.lifecycle.reap_finalize_failed", id: row.id, err: (err as Error).message }, "orphaned wav finalize failed");
    }
  }
  if (active.length > 0) {
    log.info({ event: "meeting.lifecycle.boot_reap", count: active.length }, "rescheduled auto-end for active meetings");
  }
}

// ─── Artifact cleanup ─────────────────────────────────────
// Walks meetings ended more than N days ago + unlinks the .ogg
// recording + every assistant comment's .mp3. Logs the count so an
// operator can tell at a glance whether cleanup is running.
const ARTIFACT_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;  // every 24h

export async function cleanupOldMeetingArtifacts(log: FastifyBaseLogger): Promise<{
  meetingsScanned: number;
  recordingsDeleted: number;
  ttsDeleted: number;
}> {
  const cutoff = new Date(Date.now() - ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const ended = await prisma.meetingSession.findMany({
    where: { status: "ended", endedAt: { lt: cutoff } },
    select: { id: true },
  });
  let recordingsDeleted = 0;
  let ttsDeleted = 0;
  const recDir = resolve(join(env.DATA_DIR, "meeting-recordings"));
  const ttsDir = resolve(join(env.DATA_DIR, "meeting-tts"));
  for (const m of ended) {
    // Current recordings are .wav; .ogg is the legacy name (pre-PCM) — try
    // both so the retention sweep still cleans up older meetings.
    let recDeleted = false;
    for (const ext of ["wav", "ogg"]) {
      try { await unlink(join(recDir, `${m.id}.${ext}`)); recDeleted = true; } catch { /* may not exist */ }
    }
    if (recDeleted) recordingsDeleted++;
    // Unlink every TTS clip for this meeting's comments, regardless of
    // ttsAudioUrl: streamed assistant comments write per-sentence `<id>-<seq>.mp3`
    // files but leave ttsAudioUrl null, so a ttsAudioUrl-gated sweep never
    // reaped them (unbounded disk growth). We readdir the tts dir once and
    // unlink both the whole-comment `<id>.mp3` and the per-sentence
    // `<id>-<seq>.mp3` clips for each comment id.
    const comments = await prisma.meetingComment.findMany({
      where: { sessionId: m.id },
      select: { id: true },
    });
    if (comments.length > 0) {
      ttsDeleted += await unlinkTtsClipsForComments(ttsDir, comments.map((c) => c.id));
    }
  }
  log.info(
    { event: "meeting.artifact_cleanup", meetingsScanned: ended.length, recordingsDeleted, ttsDeleted, retentionDays: ARTIFACT_RETENTION_DAYS },
    "meeting artifact cleanup complete",
  );
  return { meetingsScanned: ended.length, recordingsDeleted, ttsDeleted };
}

// ─── Public install hook ──────────────────────────────────
// Called once from server bootstrap. Fires the boot reaper +
// schedules the daily cleanup interval. The interval is
// `unref()`d so it doesn't block process shutdown.
let installed = false;
export async function installMeetingLifecycle(log: FastifyBaseLogger): Promise<void> {
  if (installed) return;
  installed = true;
  await reapStaleActiveMeetings(log);
  // Fire cleanup once at boot, then every 24h thereafter.
  void cleanupOldMeetingArtifacts(log).catch((err) => {
    log.error({ event: "meeting.artifact_cleanup_failed", err: (err as Error).message }, "boot artifact cleanup failed");
  });
  const interval = setInterval(() => {
    void cleanupOldMeetingArtifacts(log).catch((err) => {
      log.error({ event: "meeting.artifact_cleanup_failed", err: (err as Error).message }, "periodic artifact cleanup failed");
    });
  }, CLEANUP_INTERVAL_MS);
  interval.unref?.();
}

// Reset hook for tests that need to re-install with fresh state.
export function _resetInstallFlagForTests(): void {
  installed = false;
}
