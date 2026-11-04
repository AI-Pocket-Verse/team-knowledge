import { L, appLang } from "../utils/lang.js";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { resolve, join } from "node:path";
import { mkdirSync, createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { meetingConfigSchema } from "../schemas/meeting.js";
import { getSttProvider } from "../services/stt/registry.js";
import { isVolcBreakerOpen } from "../services/stt/fallback.js";
import type { SttSession } from "../services/stt/types.js";
import { TriggerEngine } from "../services/meeting/trigger.js";
import { streamAssistantComment } from "../services/meeting/speaker.js";
import { meetingAssistantSemaphore } from "../utils/concurrency.js";
import { canViewMeeting } from "../utils/meeting-access.js";
import { isAllowedOrigin } from "../utils/origin.js";
import type { MeetingConfig } from "@team-knowledge/shared";
import { ASSISTANT_NAME } from "../utils/assistant.js";

// ───助手会议 WebSocket ────────────────────────────────────
// Audio path scaffolding. The host's browser uploads Opus chunks
// over a binary WebSocket; viewers connect read-only and receive
// presence + audio-status events. STT and assistant chime
// land on top of this same broadcast mechanism.
//
// Single in-memory registry — multi-instance deployments need
// Redis pub/sub later. Server restart wipes the map: active rows
// in the DB will look "active" with no live channel; cleanup hook
// at startup would address it but isn't strictly required for MVP.
//
// Per-session disk recording is OPTIONAL — gated by the meeting's
// config.recording flag. When enabled, the host's binary frames
// are appended to data/meeting-recordings/<sessionId>.wav via a
// lazy WriteStream; MediaRecorder's container fragments stitch
// cleanly when written contiguously from a single host session.

// Per-session backpressure: we cap the in-memory queue of pending
// audio chunks at this size while waiting for `drain`. Beyond it,
// new chunks are dropped + a warning is logged — better than
// OOM'ing the process when disk I/O can't keep up.
const MAX_PENDING_WRITE_CHUNKS = 256; // ~128 KiB at typical Opus rate

// ─── STT stall recovery (recycle, not shed) ──────────────────────
// 火山 can recognize a busy meeting slower than real time, and worse, it
// sometimes goes SILENTLY UNRESPONSIVE — the WS stays "open" but it stops
// emitting results, so the backlog never drains. The previous approach (shed
// audio until the backlog drained below a low-water mark) deadlocked in exactly
// that case: with nothing fed, the backlog couldn't drain, so the gate never
// released and the transcript froze permanently.
//
// New approach: when the recognition backlog (sttSession.lagMs()) exceeds
// RECYCLE_MS, RECYCLE the upstream session — close it and reopen a fresh one
// that starts at the live edge (lag 0). We discard the un-recognized backlog
// (a gap), but the transcript can NEVER freeze: a fresh session always either
// keeps up or gets recycled again. Wall-clock timestamp anchoring keeps the
// resumed transcript continuous. Disk recording is UNAFFECTED. Client-side VAD
// (useAudioUpload.ts) and a faster 火山 model are the real latency levers; this
// is purely a stuck-upstream safety net.
const STT_RECYCLE_MS = 10_000;

// Upper bound on how long ensureSttSession will wait for a prior session's
// close() to settle before opening a fresh one (the flush-before-open ordering
// gate). The provider close() already self-bounds at CLOSE_WAIT_TIMEOUT_MS (~3s,
// volc.ts), so a healthy close resolves well under this; this is the safety net
// for a close() that wedges anyway — without it a single hung close would
// permanently stop STT from reopening and silently freeze the live transcript.
const STT_CLOSING_WAIT_TIMEOUT_MS = 5_000;

interface SessionState {
  sessionId: string;
  // The currently-streaming host's socket, or null if host hasn't
  // connected yet / disconnected. Only the host writes audio.
  host: WebSocket | null;
  hostUserId: string | null;
  hostMicMuted: boolean;
  // Whether disk recording is enabled (mirrors meeting.config.recording
  // at session creation time). False → ensureRecordingStream is a no-op
  // and chunks are dropped after the host-identity check.
  recordingEnabled: boolean;
  // All read-only viewer connections. A connection joined as host
  // is NOT in this set (mutually exclusive — viewers can't speak,
  // host doesn't show up in "12 围观" count).
  viewers: Set<WebSocket>;
  // Disk write stream for the recording file. Opened lazily on the
  // host's first audio chunk; closed when the session ends.
  recordingStream: WriteStream | null;
  recordingPath: string | null;
  totalBytes: number;
  chunkCount: number;
  // True while waiting for the WriteStream's `drain` event — new
  // chunks queue up until then. Bounded queue prevents OOM.
  writePaused: boolean;
  pendingChunks: Buffer[];
  droppedChunks: number;
  // Set true the moment shutdownMeetingChannel begins — subsequent
  // calls are no-ops (idempotent). Critical because the REST DELETE
  // and the host's "close" tab can race.
  shuttingDown: boolean;
  // STT session, opened the first time the host streams audio.
  // Outlives transient host disconnects (a reconnecting host
  // continues feeding the same session). Closed in shutdown.
  sttSession: SttSession | null;
  // Poison flag — flips true the first time getSttProvider() or
  // provider.open() throws. Once set, ensureSttSession becomes a
  // no-op so we don't log the same stack trace at ~2 Hz for the
  // rest of the meeting. Reset on `recording_stopped` so a manual
  // restart after fixing env gets a fresh try.
  sttFailed: boolean;
  // Outstanding STT close promise. Set when `recording_stopped`
  // fires a fire-and-forget close; the next ensureSttSession()
  // awaits it so the old session's trailing onFinal can't race
  // ahead of the new session's first onPartial.
  sttClosing: Promise<void> | null;
  // in-flight async open promise. The registry now resolves
  // credentials from the DB so getSttProvider() is async; the WS
  // message handler is sync. We kick the open in the background
  // and drop the triggering chunk; subsequent chunks find the
  // session ready (< 100ms typical). Reset on settle.
  sttOpening: Promise<void> | null;
  // Count of times we've recycled the upstream STT session because its backlog
  // crossed STT_RECYCLE_MS (stuck/slow 火山) — observability only.
  sttRecycles: number;
  // Running counts of STT partial/final events, used purely to THROTTLE their
  // INFO logging. A busy meeting fires tens of thousands of these; logging
  // every one floods the log + hurts throughput. We log only the first few +
  // every Nth thereafter (see onPartial/onFinal).
  sttPartialCount: number;
  sttFinalCount: number;
  // Wall-clock at meeting start. SttSession uses this to compute
  // offsets that match MeetingTranscript.startMs / endMs.
  meetingStartedAtMs: number;
  // meeting config (allowed roles, freqLimit, triggers).
  // Used by the trigger engine + assistant speaker.
  meetingConfig: MeetingConfig | null;
  // The meeting host's user id — used as the "asker" for natural
  // triggers (keyword, silence, explicit_wake) so retrieval is
  // scoped to permissions a participant in the meeting actually has.
  hostId: string | null;
  // Cached host displayName so the broadcast can label
  // explicit_wake / silence-driven comments without a per-event
  // user lookup.
  hostName: string | null;
  // Cached host isAdmin so FTS5 retrieval for natural triggers
  // uses the right canView gate. Without this, admin-hosted
  // meetings silently lose access to private docs the host can
  // actually see (a past regression).
  hostIsAdmin: boolean;
  // AbortController plumbed into the speaker's LLM call so a
  // mid-flight assistant generation is cancelled when the meeting
  // ends — prevents phantom MeetingComment rows that nobody saw.
  assistantAbort: AbortController | null;
  // Per-user cooldown for ask_assistant. Prevents a single
  // participant from burning all 20 hard-cap slots in one burst.
  lastAskAtByUser: Map<string, number>;
  // Per-user lifetime ask count (ask_assistant only). A non-host asker is capped
  // at PER_VIEWER_ASK_CAP so neither one chatty viewer nor a collective viewer
  // set can drain the global 20-cap and starve the host. The host is exempt.
  askCountByUser: Map<string, number>;
  // meeting's allowed role ids (parsed from DB JSON) —
  // assistant retrieval is intersected with this set.
  allowedRoleIds: string[];
  // per-meeting trigger engine. Lazily created when we first
  // need it (the first transcript final OR the first manual ask).
  trigger: TriggerEngine | null;
  // timer that periodically polls the trigger engine for the
  // silence trigger. Cleared in shutdown.
  silenceTimer: NodeJS.Timeout | null;
  // serializes assistant comment generation per session so two
  // simultaneous triggers don't race into two parallel LLM calls.
  assistantBusy: boolean;
  // flips true the instant shutdownMeetingChannel has finished
  // awaiting the STT session's close() (i.e. its intentional trailing
  // flush has been persisted). After this point the channel is gone
  // and the summary read has either run or is about to — so any FURTHER
  // onFinal (a volc server frame that lands AFTER close() resolved, or
  // the 3s close timeout fired) must NOT persist: it would create a
  // transcript row after status="ended" / after generateMeetingSummary
  // read the rows, silently excluding the segment from the summary while
  // leaving it on the row. The legitimate close()-flushed final fires
  // DURING the awaited close() (sttClosed still false) so it IS captured.
  sttClosed: boolean;
}

const sessions = new Map<string, SessionState>();

function getOrCreateState(
  sessionId: string,
  recordingEnabled: boolean,
  meetingStartedAtMs: number,
  meetingConfig: MeetingConfig,
  allowedRoleIds: string[],
  hostId: string,
  hostName: string | null,
  hostIsAdmin: boolean,
): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      host: null,
      hostUserId: null,
      hostMicMuted: false,
      recordingEnabled,
      viewers: new Set(),
      recordingStream: null,
      recordingPath: null,
      totalBytes: 0,
      chunkCount: 0,
      writePaused: false,
      pendingChunks: [],
      droppedChunks: 0,
      shuttingDown: false,
      sttSession: null,
      sttFailed: false,
      sttClosing: null,
      sttOpening: null,
      sttRecycles: 0,
      sttPartialCount: 0,
      sttFinalCount: 0,
      meetingStartedAtMs,
      meetingConfig,
      hostId,
      hostName,
      hostIsAdmin,
      allowedRoleIds,
      trigger: null,
      silenceTimer: null,
      assistantBusy: false,
      assistantAbort: null,
      lastAskAtByUser: new Map(),
      askCountByUser: new Map(),
      sttClosed: false,
    };
    sessions.set(sessionId, s);
  } else {
    // First WS connect locks the recording mode in; an admin toggling
    // config mid-flight would need a meeting restart to take effect.
    s.recordingEnabled = recordingEnabled;
    s.meetingConfig = meetingConfig;
    s.allowedRoleIds = allowedRoleIds;
    s.hostName = hostName ?? s.hostName;
    s.hostIsAdmin = hostIsAdmin;
  }
  return s;
}

// Lazy trigger engine — created on demand. The first transcript_final
// OR a manual ask is enough to spin it up. Once created it lives
// for the rest of the session.
function ensureTriggerEngine(s: SessionState): TriggerEngine {
  if (s.trigger) return s.trigger;
  s.trigger = new TriggerEngine(s.meetingConfig!, s.meetingStartedAtMs);
  // Start the silence-trigger poller — every 10s checks whether
  // the conversation has stalled. Cheap (in-memory state check)
  // so the loop cost is negligible even across hundreds of meetings.
  //
  // Retrieval identity (3 distinct paths in this codebase):
  //   - chat.ts          → asker = the chatting user
  //   - meeting natural  → asker = the meeting host (silence /
  //                        keyword / wake — the host's voice drove
  //                        the trigger so retrieval inherits their
  //                        permissions, scoped by allowedRoleIds)
  //   - meeting manual   → asker = the user who clicked ask_assistant /
  //                        comment_now
  s.silenceTimer = setInterval(() => {
    if (s.shuttingDown || !s.trigger || s.assistantBusy) return;
    const nowRel = Date.now() - s.meetingStartedAtMs;
    // Silence (an unanswered question on the floor) takes priority;
    // otherwise fall back to the proactive accrual trigger so assistant
    // joins a normal flowing discussion without anyone prompting her.
    const silence = s.trigger.evaluateSilence(nowRel);
    const decision = silence.fire ? silence : s.trigger.evaluateProactive(nowRel);
    if (decision.fire) {
      void fireAssistantChime(s, {
        trigger: decision.trigger,
        askerUserId: s.hostId!,
        askerIsAdmin: s.hostIsAdmin,
        askerName: s.hostName,
      });
    }
  }, 10_000);
  return s.trigger;
}

// Lazy STT session — opened on the host's first audio chunk so we
// don't allocate a provider connection for sessions where the host
// never speaks. Persists across host disconnect/reconnect cycles so
// a single segment can span a brief network blip.
//
// Returns null when:
//   * the session was previously poisoned by a provider failure
//     (avoids re-logging the same stack trace at chunk rate), OR
//   * provider.open() throws on this call (sets the poison flag).
// Callers MUST tolerate a null result — chunks just get dropped
// silently for the rest of the meeting; a `recording_stopped` +
// restart resets the poison so the user gets another chance.
function ensureSttSession(s: SessionState, log: FastifyBaseLogger): SttSession | null {
  if (s.sttSession) return s.sttSession;
  if (s.sttFailed) return null;
  // Background open already in flight — drop this chunk; next one
  // will find the session ready.
  if (s.sttOpening) return null;
  log.info({ event: "meeting.stt.opening", sessionId: s.sessionId }, "stt session opening (lazy)");
  s.sttOpening = (async () => {
    // Ordering gate: if a previous session is still closing (manual stop OR
    // a lag-triggered recycle), wait for it to fully flush its trailing
    // onFinal before opening a fresh one. Otherwise the recycled session's
    // late final could arrive AFTER the new session's first partial and
    // corrupt transcript order. Clear it once awaited so the next chunk
    // doesn't re-await a resolved promise. Skip if a teardown began meanwhile.
    //
    // BOUNDED: race the await against a short timeout so a provider close()
    // that hangs (a wedged upstream socket whose own CLOSE_WAIT_TIMEOUT_MS
    // didn't fire) can't permanently block STT from reopening — which would
    // silently freeze the live transcript for the rest of the meeting. After
    // the timeout we proceed to open a fresh session regardless; the worst
    // case is a brief out-of-order trailing final from the still-closing
    // session, which is strictly better than no transcript at all.
    if (s.sttClosing) {
      await Promise.race([
        s.sttClosing.catch(() => { /* noop */ }),
        new Promise<void>((res) => setTimeout(res, STT_CLOSING_WAIT_TIMEOUT_MS)),
      ]);
      s.sttClosing = null;
      if (s.shuttingDown) return;
    }
    let provider;
    try {
      provider = await getSttProvider();
      log.info({ event: "meeting.stt.provider_resolved", sessionId: s.sessionId, provider: provider.name }, "stt provider resolved");
    } catch (err) {
      s.sttFailed = true;
      log.error({ event: "meeting.stt.provider_failed", sessionId: s.sessionId, err: (err as Error).message }, "stt provider unavailable; remaining chunks this meeting will be dropped");
      return;
    }
    try {
      const session = provider.open({
        sessionId: s.sessionId,
        meetingStartedAtMs: s.meetingStartedAtMs,
        onPartial: (text, atMs) => {
          // Throttle: partials fire continuously (tens of thousands/meeting)
          // and each is superseded by the next, so logging every one floods
          // the log for no diagnostic gain. Log the first few + every 100th.
          s.sttPartialCount += 1;
          if (s.sttPartialCount <= 3 || s.sttPartialCount % 100 === 0) {
            log.info({ event: "meeting.stt.partial", sessionId: s.sessionId, n: s.sttPartialCount, textLen: text.length, atMs }, "stt partial");
          }
          broadcastAll(s, { type: "transcript_partial", text, atMs });
        },
        onFinal: (text, startMs, endMs) => {
          // Throttle like partials (lower volume, but a long meeting still
          // produces thousands of finals). First few + every 20th.
          s.sttFinalCount += 1;
          if (s.sttFinalCount <= 3 || s.sttFinalCount % 20 === 0) {
            log.info({ event: "meeting.stt.final", sessionId: s.sessionId, n: s.sttFinalCount, textLen: text.length, startMs, endMs }, "stt final");
          }
          void persistAndBroadcastTranscript(s, text, startMs, endMs, log);
          // feed the final into the trigger engine. If it
          // fires, spin up an assistant chime. Natural triggers
          // (explicit_wake / keyword) use the meeting HOST as the
          // asker — assistant retrieval is gated on their permissions.
          try {
            const eng = ensureTriggerEngine(s);
            const decision = eng.onTranscriptFinal({ text, endMs });
            if (decision.fire) {
              void fireAssistantChime(s, {
                trigger: decision.trigger,
                askerUserId: s.hostId!,
                askerIsAdmin: s.hostIsAdmin,
                askerName: s.hostName,
              });
            }
          } catch (err) {
            log.warn({ event: "meeting.trigger.failed", sessionId: s.sessionId, err: (err as Error).message }, "trigger evaluation failed");
          }
        },
        onError: (msg) => {
          // `detail`, not `msg`: pino reserves `msg` for the log message, so a
          // `msg` field gets swallowed — the real STT error must ride a
          // non-reserved key to actually show up in the logs.
          log.warn({ event: "meeting.stt.error", sessionId: s.sessionId, detail: msg }, "stt warning");
        },
        onClosed: (reason) => {
          // Upstream died unexpectedly (e.g. 火山 "session has ended") or a
          // degraded cooldown elapsed. Drop the dead session so the NEXT chunk
          // reopens a fresh one — otherwise we'd keep no-op-pushing into a
          // corpse and never transcribe again. Guard on identity so a stale
          // session's late onClosed can't null a newer one, and skip during
          // shutdown (that close() is intentional).
          if (s.shuttingDown) return;
          if (s.sttSession !== session) return;
          s.sttSession = null;
          log.info({ event: "meeting.stt.reopen_pending", sessionId: s.sessionId, reason }, "stt session ended; reopening on next chunk");
        },
      });
      s.sttSession = session;
      log.info({ event: "meeting.stt.opened", sessionId: s.sessionId, provider: provider.name }, "stt session opened");
    } catch (err) {
      s.sttFailed = true;
      log.error({ event: "meeting.stt.open_failed", sessionId: s.sessionId, err: (err as Error).message }, "stt open failed; remaining chunks this meeting will be dropped");
    }
  })().finally(() => { s.sttOpening = null; });
  return null;
}

// Forward one audio chunk to STT with lag backpressure. When the provider's
// recognition backlog (lagMs) climbs past HIGH we enter catch-up and DROP
// chunks until it drains below LOW — trading a little lost speech for a
// transcript that tracks real time instead of falling minutes behind. The gate
// is a no-op for providers that don't report lagMs (stub / degraded): they
// always "keep up", so nothing is shed. Disk recording is handled by the caller
// before this, so dropped audio is still recorded — only live STT sheds.
function pushAudioToStt(
  s: SessionState,
  session: SttSession | null,
  chunk: Buffer,
  log: FastifyBaseLogger,
): void {
  if (!session) return;
  // If the recognition backlog is too large — 火山 is far behind OR has gone
  // silently unresponsive (still "open" but no longer advancing) — recycle the
  // session to the live edge instead of feeding a black hole. Drop s.sttSession
  // ONLY when it's still the current one, so the next chunk's ensureSttSession
  // reopens exactly one fresh session; this chunk + in-flight chunks no-op until
  // it's ready, so we never recycle in a tight loop. close() is fire-and-forget
  // and flags the close as client-initiated, so it won't also fire onClosed.
  if ((session.lagMs?.() ?? 0) > STT_RECYCLE_MS && s.sttSession === session) {
    s.sttRecycles += 1;
    log.warn({ event: "meeting.stt.recycle", sessionId: s.sessionId, lagMs: Math.round(session.lagMs?.() ?? 0), recycles: s.sttRecycles },
      "stt backlog too high or upstream stalled — recycling session to the live edge");
    s.sttSession = null;
    // Stash the closing promise (same ordering gate as the manual-stop path):
    // the next ensureSttSession awaits + clears it before opening a fresh
    // session, so the recycled session's trailing onFinal flushes BEFORE the
    // new session's first partial — otherwise a late final corrupts transcript
    // order. Don't overwrite an existing close-in-flight (manual stop racing a
    // recycle); chaining onto it preserves the same flush-before-open ordering.
    s.sttClosing = s.sttClosing
      ? s.sttClosing.then(() => session.close()).catch(() => { /* noop */ })
      : session.close().catch(() => { /* noop */ });
    return;
  }
  try {
    session.pushChunk(chunk);
  } catch (err) {
    log.error({ err: (err as Error).message, sessionId: s.sessionId }, "stt push failed");
  }
}

// kick the assistant speaker for a triggered chime.
//   * Serialized per-session via state.assistantBusy so two near-
//     simultaneous triggers don't fire two parallel LLM calls.
//   * After generation, calls trigger.recordComment so the freq
//     limit applies to the natural-trigger paths.
//   * Always logs the outcome; never throws back to the caller.
async function fireAssistantChime(
  s: SessionState,
  opts: { trigger: "explicit_wake" | "keyword" | "silence" | "proactive" | "manual_button" | "user_question";
    askerUserId: string; askerIsAdmin: boolean; askerName: string | null; question?: string;
    // Invoked when this chime is dropped by the assistantBusy re-check below. The
    // manual ask_assistant / comment_now handlers check assistantBusy synchronously,
    // but the actual fire is a scheduled microtask — so a second rapid manual
    // ask can pass the handler's check then lose the busy re-check here and
    // vanish with no UI feedback. The manual paths pass this to surface an
    // assistant_skipped to the asker; natural triggers omit it (no spam).
    onBusySkip?: () => void },
): Promise<void> {
  if (s.assistantBusy || s.shuttingDown) {
    if (s.assistantBusy && !s.shuttingDown) opts.onBusySkip?.();
    return;
  }
  if (!s.meetingConfig || !s.trigger) return;
  s.assistantBusy = true;
  // Per-chime AbortController — `shutdownMeetingChannel` aborts
  // this to cancel an in-flight LLM token stream + skip pending
  // per-sentence TTS so the trailing generation can't broadcast
  // on a torn-down channel.
  const ac = new AbortController();
  s.assistantAbort = ac;
  // Each broadcast is gated on !s.shuttingDown so a generation that
  // outlives the channel teardown can't push frames onto closing
  // sockets. The abort stops most of it; this is belt-and-suspenders.
  const live = () => !s.shuttingDown;
  // bound the TOTAL meeting-assistant LLM fan-out across ALL meetings with a
  // dedicated semaphore. assistantBusy already serializes within THIS meeting, so
  // a meeting holds at most one slot; this caps M-meeting concurrency. A
  // saturated cap degrades to a skipped chime (bounded acquire timeout) rather
  // than a hung generation — released in the outer finally.
  let releaseSlot: (() => void) | null = null;
  try {
    try {
      releaseSlot = await meetingAssistantSemaphore.acquire(30_000);
    } catch {
      if (live()) broadcastAll(s, { type: "assistant_skipped", reason: L(appLang(), `${ASSISTANT_NAME} 当前繁忙，请稍后再试`, `${ASSISTANT_NAME} is busy. Try again later`) });
      return;
    }
    // The meeting may have ended (or this chime been aborted) while we waited
    // for a slot — bail before spawning the LLM so we don't strand a phantom
    // generation on a torn-down channel.
    if (s.shuttingDown || ac.signal.aborted) return;
    const log = serverLog(s);
    const nowMs = Date.now() - s.meetingStartedAtMs;
    // Streaming protocol: start → deltas → per-sentence tts → done.
    const result = await streamAssistantComment({
      sessionId: s.sessionId,
      allowedRoleIds: s.allowedRoleIds,
      askerUserId: opts.askerUserId,
      askerIsAdmin: opts.askerIsAdmin,
      askerName: opts.askerName,
      recentTranscript: s.trigger.recentTranscriptText(),
      trigger: opts.trigger,
      question: opts.question,
      atMs: nowMs,
      abortSignal: ac.signal,
    }, {
      onStart: (meta) => {
        if (!live()) return;
        broadcastAll(s, {
          type: "assistant_comment_start",
          id: meta.id,
          triggerType: meta.triggerType,
          triggeredByUserId: meta.triggeredByUserId,
          triggeredByName: meta.triggeredByName,
          atMs: meta.atMs,
          createdAt: meta.createdAt,
        });
      },
      onDelta: (id, text) => {
        if (!live()) return;
        broadcastAll(s, { type: "assistant_comment_delta", id, text });
      },
      onSentenceTts: (id, seq, audioUrl) => {
        if (!live()) return;
        broadcastAll(s, { type: "assistant_comment_tts", id, seq, audioUrl });
      },
      onDone: (id, text, citedArticleIds, citedRefs) => {
        if (!live()) return;
        broadcastAll(s, { type: "assistant_comment_done", id, text, citedArticleIds, citedRefs });
      },
    }, log);
    if (s.shuttingDown) {
      serverLog(s).info({ event: "meeting.assistant.discarded_post_shutdown", sessionId: s.sessionId }, "assistant result dropped — meeting ended mid-generation");
      return;
    }
    if (!result.started) {
      // 检索/落库失败,或生成无任何产出(此时未发过 start 帧)。Tell the asker so
      // their UI doesn't look broken. For natural triggers (host is
      // the asker) the host's panel surfaces it too.
      broadcastAll(s, { type: "assistant_skipped", reason: "generation_failed" });
      return;
    }
    s.trigger.recordComment(nowMs);
  } finally {
    if (releaseSlot) releaseSlot();
    s.assistantBusy = false;
    if (s.assistantAbort === ac) s.assistantAbort = null;
  }
}

// Pluggable logger reference — we cache the most-recent FastifyBaseLogger
// from a connection so the silence-timer / assistant fire path can log
// without holding onto a connection that may have closed.
const sessionLoggers = new WeakMap<SessionState, FastifyBaseLogger>();
function serverLog(s: SessionState): FastifyBaseLogger {
  return sessionLoggers.get(s) ?? (console as unknown as FastifyBaseLogger);
}

// Persist a final transcript segment + broadcast it. Best-effort:
// a DB failure is logged but the broadcast still goes out so the
// viewer's screen doesn't desync from what the host heard.
//
// Race guard: shutdownMeetingChannel awaits the STT session's close(),
// which intentionally flushes ONE trailing onFinal (stub.ts flushFinal /
// volc LAST_AUDIO → server trailing segment) — that final fires DURING the
// awaited close() (sttClosed still false) and MUST be persisted so trailing
// audio is captured AND lands before the DELETE handler's summary read. But
// volc can also deliver a server frame on ws.on("message") AFTER close()
// resolved (the message arrived just after, or the 3s close-wait timeout
// fired), reaching here via the fire-and-forget `void persistAnd…` in
// onFinal. That late final would create a transcript row AFTER status="ended"
// and AFTER generateMeetingSummary already read the rows — silently excluded
// from the summary yet left on the row (and possibly after save-as-article
// snapshotted the text). We gate on sttClosed (set only once close() has
// returned) so the legitimate trailing flush persists while any genuinely
// post-shutdown final is dropped. The broadcast is also skipped post-close
// since all sockets are already torn down.
async function persistAndBroadcastTranscript(
  s: SessionState,
  text: string,
  startMs: number,
  endMs: number,
  log: FastifyBaseLogger,
): Promise<void> {
  if (s.sttClosed) {
    log.info({ event: "meeting.transcript.skipped_post_shutdown", sessionId: s.sessionId, textLen: text.length }, "trailing transcript dropped — stt session already closed during shutdown");
    return;
  }
  let row: { id: string } | null = null;
  try {
    row = await prisma.meetingTranscript.create({
      data: { sessionId: s.sessionId, text, startMs, endMs },
      select: { id: true },
    });
  } catch (err) {
    log.error({ event: "meeting.transcript.persist_failed", sessionId: s.sessionId, err: (err as Error).message }, "transcript persist failed");
  }
  broadcastAll(s, {
    type: "transcript_final",
    id: row?.id ?? `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    startMs,
    endMs,
  });
}

// Parse the JSON config column off MeetingSession into a fully-
// defaulted MeetingConfig. Malformed JSON or missing fields fall
// back to schema defaults (recording on, freqLimit 5min, etc).
function meetingConfig(raw: string): MeetingConfig {
  try {
    return meetingConfigSchema.parse(JSON.parse(raw));
  } catch {
    return meetingConfigSchema.parse({});
  }
}

function recordingDir(): string {
  return resolve(env.DATA_DIR, "meeting-recordings");
}

function ensureRecordingDir(): void {
  mkdirSync(recordingDir(), { recursive: true });
}

// Defense-in-depth: cuid is alphanumeric so the regex passes in
// practice, but if the id format ever changes (or an attacker
// crafts a row with `..` in the id) this stops path traversal
// from escaping the recording dir. The resolve-prefix check is
// the second line of defense.
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
// Exported so the lifecycle reaper can resolve the orphaned recording path for
// a stale-active meeting after a server restart (and finalize its WAV header).
export function safeRecordingPath(sessionId: string): string | null {
  if (!SAFE_SESSION_ID.test(sessionId)) return null;
  const base = resolve(recordingDir());
  const full = resolve(join(base, `${sessionId}.wav`));
  if (!full.startsWith(base + "/") && full !== base) return null;
  return full;
}

// Host chunks are now raw 16 kHz s16le mono PCM (see useAudioUpload.ts), so the
// recording is a WAV file: a 44-byte header followed by the concatenated PCM.
// We write the header with placeholder sizes when the file is first created,
// then patch the two size fields on finalize (PCM is headerless + concatenable,
// so host reconnects just append more samples — no per-segment header).
const WAV_SAMPLE_RATE = 16_000;
const WAV_CHANNELS = 1;
const WAV_BITS = 16;
const WAV_HEADER_BYTES = 44;
function wavHeader(dataLen: number): Buffer {
  const b = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = (WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS) / 8;
  const blockAlign = (WAV_CHANNELS * WAV_BITS) / 8;
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataLen, 4);     // RIFF chunk size = 36 + data
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);              // fmt chunk size
  b.writeUInt16LE(1, 20);              // audio format = PCM
  b.writeUInt16LE(WAV_CHANNELS, 22);
  b.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(WAV_BITS, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataLen, 40);         // data chunk size
  return b;
}

// Patch the RIFF + data size fields once the PCM is fully written. Exported so
// the lifecycle reaper can finalize an orphaned file's header on restart (its
// RIFF/data sizes were never patched if the process died mid-recording).
export async function finalizeWavSizes(path: string): Promise<void> {
  try {
    const size = statSync(path).size;
    if (size < WAV_HEADER_BYTES) return; // header-only / empty — nothing to patch
    const dataLen = size - WAV_HEADER_BYTES;
    const fd = await fsOpen(path, "r+");
    try {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(36 + dataLen, 0); await fd.write(buf, 0, 4, 4);
      buf.writeUInt32LE(dataLen, 0);      await fd.write(buf, 0, 4, 40);
    } finally {
      await fd.close();
    }
  } catch { /* best-effort — a corrupt-size WAV still plays to EOF in most players */ }
}

// Lazy-open the per-session disk file the first time a host chunk
// arrives. Avoids creating empty .ogg files for sessions where the
// host never actually presses 🎙️ (or denied mic permission).
// Returns null when recording is disabled OR the session id failed
// the safety check.
function ensureRecordingStream(s: SessionState): WriteStream | null {
  if (!s.recordingEnabled) return null;
  if (s.recordingStream) return s.recordingStream;
  const path = safeRecordingPath(s.sessionId);
  if (!path) return null;
  ensureRecordingDir();
  // `flags: "a"` — append. If the host reconnects mid-session
  // (network blip → reload), new chunks get tacked onto the same
  // file rather than truncating. MediaRecorder restarts emit a
  // fresh container header that browsers tolerate when stitched.
  // Write the WAV header exactly once — when the file is first created. On a
  // host reconnect mid-session the file already exists, so we just append more
  // PCM (concatenable) rather than injecting a second header.
  const isNew = !existsSync(path) || statSync(path).size === 0;
  const stream = createWriteStream(path, { flags: "a" });
  if (isNew) stream.write(wavHeader(0)); // placeholder sizes; patched on finalize
  // When the stream drains, flush queued chunks and resume writes.
  stream.on("drain", () => flushPending(s));
  stream.on("error", () => { /* swallow — write() failures are logged at call site */ });
  s.recordingStream = stream;
  s.recordingPath = path;
  return stream;
}

function flushPending(s: SessionState): void {
  if (!s.recordingStream) return;
  while (s.pendingChunks.length > 0) {
    const chunk = s.pendingChunks.shift()!;
    const ok = s.recordingStream.write(chunk);
    if (!ok) {
      s.writePaused = true;
      return;
    }
  }
  s.writePaused = false;
}

// Append a chunk to the recording with backpressure honored. Drops
// chunks (with a counter for observability) when the queue overflows
// — better than letting memory grow unbounded on a slow disk.
function writeChunk(s: SessionState, chunk: Buffer, log?: { warn?: (o: object, m: string) => void }): void {
  const stream = ensureRecordingStream(s);
  if (!stream) return;
  if (s.writePaused) {
    if (s.pendingChunks.length >= MAX_PENDING_WRITE_CHUNKS) {
      s.droppedChunks += 1;
      if (s.droppedChunks === 1 || s.droppedChunks % 50 === 0) {
        log?.warn?.({ sessionId: s.sessionId, droppedChunks: s.droppedChunks }, "recording write backpressure: dropping chunk");
      }
      return;
    }
    s.pendingChunks.push(chunk);
    return;
  }
  const ok = stream.write(chunk);
  if (!ok) s.writePaused = true;
}

// Serialize an app-level event as a JSON text frame. Wrapper exists
// so call sites read like "publish event" rather than the noisy raw
// .send(JSON.stringify(...)).
function sendEvent(socket: WebSocket, event: Record<string, unknown>): void {
  if (socket.readyState !== 1 /* OPEN */) return;
  try {
    socket.send(JSON.stringify(event));
  } catch { /* ignore — disconnects are caught by the close handler */ }
}

function broadcastAll(s: SessionState, event: Record<string, unknown>): void {
  if (s.host) sendEvent(s.host, event);
  for (const v of s.viewers) sendEvent(v, event);
}

function broadcastViewerCount(s: SessionState): void {
  broadcastAll(s, { type: "viewer_count", count: s.viewers.size });
}

// Send the auth/upgrade error frame, then close. The WebSocket spec
// guarantees the close frame is sent AFTER all queued data frames,
// so by sending the JSON first + close second on the same tick we
// don't need an arbitrary setTimeout to flush — the ordering is
// kernel-guaranteed at the WS protocol level.
function rejectAndClose(socket: WebSocket, code: number, reason: string, errorCode: string, message: string): void {
  sendEvent(socket, { type: "error", code: errorCode, message });
  try { socket.close(code, reason); } catch { /* noop */ }
}

// PUBLIC: 会议被改为私密时由 REST PATCH 调用。私密会议只有创建者(主持人)可看,
// 而主持人走 host 槽位不在 viewers 里,所以 viewers 里的连接此刻都已失去访问权:
// 先发 forbidden 错误帧(与握手拒绝同格式),再以 4403 关闭。关闭由 close 处理器负责
// 从 viewers 移除并广播人数,这里不重复处理。
export function kickViewersFromPrivateMeeting(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  for (const v of [...s.viewers]) {
    rejectAndClose(v, 4403, "forbidden", "forbidden", L(appLang(), "该会议已改为私密，无权继续观看", "This meeting is now private. You can no longer watch it"));
  }
}

// PUBLIC: called from the REST DELETE /api/meeting/:id handler
// when the host ends a meeting. Idempotent — multiple concurrent
// callers see the same outcome. Notifies every connected client,
// closes the disk recording so the file is flushed/intact, and
// returns the URL the DB row should now point at.
export async function shutdownMeetingChannel(sessionId: string): Promise<{ recordingUrl: string | null }> {
  const s = sessions.get(sessionId);
  if (!s) return { recordingUrl: null };
  // Idempotency guard: the REST DELETE could race with the host's
  // own "close tab" path or with another admin's parallel DELETE.
  // The first caller owns the shutdown; later callers get the same
  // recordingPath back from the DB row they're about to write.
  if (s.shuttingDown) {
    return { recordingUrl: s.recordingPath ? `/meeting-recordings/${sessionId}.wav` : null };
  }
  s.shuttingDown = true;

  // Send-then-close on each socket — WS ordering guarantees the
  // session_ended frame leaves the wire before the close frame.
  // Removed the prior 20ms `setTimeout` heuristic; the new pattern
  // is race-free without it.
  if (s.host) {
    sendEvent(s.host, { type: "session_ended" });
    try { s.host.close(1000, "session_ended"); } catch { /* noop */ }
  }
  for (const v of s.viewers) {
    sendEvent(v, { type: "session_ended" });
    try { v.close(1000, "session_ended"); } catch { /* noop */ }
  }

  // stop the silence-trigger poller so it can't fire after
  // the channel is gone.
  if (s.silenceTimer) {
    clearInterval(s.silenceTimer);
    s.silenceTimer = null;
  }
  // cancel any in-flight assistant generation so the LLM call
  // returns immediately + the speaker bails before writing a
  // phantom MeetingComment row (the broadcast would also be a
  // no-op since sockets are closing).
  if (s.assistantAbort) {
    try { s.assistantAbort.abort(); } catch { /* noop */ }
    s.assistantAbort = null;
  }

  // If a host pre-warm open is mid-flight (started by the WS
  // upgrade, hasn't yet populated s.sttSession), await it before
  // tearing down — otherwise the open completes AFTER shutdown,
  // assigns to s.sttSession on an orphaned state object, and
  // leaks an outbound WS to the upstream provider.
  if (s.sttOpening) {
    try { await s.sttOpening; } catch { /* noop */ }
  }
  // Close STT session first so any trailing audio gets a final
  // segment + persisted before the channel goes away. STT close()
  // may itself emit one more onFinal — we await it.
  //
  // The close()-flushed onFinal calls persistAndBroadcastTranscript
  // SYNCHRONOUSLY inside close() (stub) / before close() resolves (volc
  // awaits the server's trailing frame), so it clears the sttClosed guard
  // (still false) and IS persisted. We flip sttClosed=true ONLY after the
  // await returns — past this point any further onFinal (a volc server
  // frame that lands after close() resolved, or after the 3s close-wait
  // timeout) is a genuinely post-shutdown final and must not persist (it
  // would land after the DELETE handler's summary read; see
  // persistAndBroadcastTranscript).
  if (s.sttSession) {
    try { await s.sttSession.close(); } catch { /* noop */ }
    s.sttSession = null;
  }
  s.sttClosed = true;

  // Flush + finalize the recording file before returning. End()'s
  // callback fires only after all buffered bytes hit disk, so the
  // URL we hand back is safe to expose immediately.
  const recordingPath = s.recordingPath;
  if (s.recordingStream) {
    // Drain the pending queue first: flush every buffered chunk to the stream
    // before ending it so queued recording bytes aren't lost on shutdown. The
    // queue is bounded (MAX_PENDING_WRITE_CHUNKS ~256), so a synchronous flush
    // loop is fine — backpressure during teardown is irrelevant since end()
    // below waits for the OS to drain all of it to disk anyway.
    while (s.pendingChunks.length > 0) {
      const chunk = s.pendingChunks.shift()!;
      try { s.recordingStream.write(chunk); } catch { /* end() callback still flushes what landed */ }
    }
    await new Promise<void>((res) => { s.recordingStream?.end(res); });
    if (recordingPath) await finalizeWavSizes(recordingPath);
  }
  sessions.delete(sessionId);
  return { recordingUrl: recordingPath ? `/meeting-recordings/${sessionId}.wav` : null };
}

// graceful-shutdown teardown for the real server process. A SIGTERM/
// SIGINT that only called app.close() left every LIVE meeting stranded: the
// trailing transcript was lost, the volc STT WS leaked, the recording WAV was
// never finalized (RIFF/data sizes stay 0), and the DB row stayed
// status:"active". This runs the full shutdownMeetingChannel for every live
// session — finalizing each recording + closing each STT session + flushing
// trailing transcripts — and flips the DB row to "ended" so a restart doesn't
// see a phantom-active meeting.
//
// Best-effort + BOUNDED: each per-meeting shutdown is raced against a timeout
// so a single wedged STT close() can't hang process shutdown forever. We snapshot
// the session ids up front (shutdownMeetingChannel mutates the map) and run them
// in parallel under one overall deadline.
const SHUTDOWN_ALL_PER_MEETING_TIMEOUT_MS = 8_000;
export async function shutdownAllMeetings(
  log?: { info?: (o: object, m: string) => void; error?: (o: object, m: string) => void },
): Promise<void> {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return;
  log?.info?.({ event: "meeting.shutdown_all.begin", count: ids.length }, "tearing down live meetings before exit");
  await Promise.all(ids.map(async (id) => {
    try {
      await Promise.race([
        (async () => {
          const { recordingUrl } = await shutdownMeetingChannel(id);
          // Flip the DB row to "ended" so a restart's reaper doesn't see a
          // phantom-active meeting (the channel is gone; nothing will resume
          // it). Best-effort — the channel teardown above already finalized
          // the recording + STT regardless of whether this write lands.
          try {
            await prisma.meetingSession.updateMany({
              where: { id, status: "active" },
              data: { status: "ended", endedAt: new Date(), ...(recordingUrl ? { recordingUrl } : {}) },
            });
          } catch { /* best-effort during shutdown */ }
        })(),
        new Promise<void>((res) => setTimeout(res, SHUTDOWN_ALL_PER_MEETING_TIMEOUT_MS)),
      ]);
    } catch (err) {
      log?.error?.({ event: "meeting.shutdown_all.failed", id, err: (err as Error).message }, "live meeting teardown failed during shutdown");
    }
  }));
  log?.info?.({ event: "meeting.shutdown_all.done", count: ids.length }, "live meeting teardown complete");
}

// Test helper. Closes every socket + flushes every stream + closes
// the STT session before clearing the map so the next test's
// resetDb + listen don't race against a still-open file handle or
// a leaked outbound WS to the STT provider.
export async function _resetMeetingWsForTests(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const s of sessions.values()) {
    s.shuttingDown = true;
    if (s.silenceTimer) { clearInterval(s.silenceTimer); s.silenceTimer = null; }
    if (s.host) { try { s.host.close(); } catch { /* noop */ } }
    for (const v of s.viewers) { try { v.close(); } catch { /* noop */ } }
    // Each session's STT shutdown is async chained: await any
    // in-flight open BEFORE close, so a host-pre-warm that lands
    // after sessions.clear() doesn't leak an outbound WS.
    pending.push((async () => {
      if (s.sttOpening) { try { await s.sttOpening; } catch { /* noop */ } }
      if (s.sttSession) { try { await s.sttSession.close(); } catch { /* noop */ } }
    })());
    if (s.recordingStream) {
      pending.push(new Promise((res) => { s.recordingStream?.end(res); }));
    }
  }
  await Promise.all(pending);
  sessions.clear();
}

// Light-weight check used by the REST routes layer (DELETE) so it
// can decide whether the in-memory channel is even live.
export function _hasLiveChannelForTests(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export async function meetingWsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/meeting/:id/stream — WebSocket upgrade.
  //
  // @fastify/websocket v10 hands the handler a (socket, request)
  // pair where `socket` is the raw `ws` WebSocket — no SocketStream
  // wrapper. The standard requireUser guard writes HTTP responses,
  // which doesn't apply to upgraded sockets — so we mirror its SSO →
  // local-user mapping inline and reject with a custom 4xxx close code
  // on failure. The auth plugin's onRequest hook has already populated
  // req.user (the SSO identity) on the upgrade request.
  app.get<{ Params: { id: string } }>(
    "/api/meeting/:id/stream",
    { websocket: true },
    async (socket, req) => {
      // 浏览器的 WebSocket 不受同源策略约束,跨站页面也能发起握手(本地模式还不需要 cookie)。
      // 带 Origin 的必须是本站来源(与 HTTP 的 CSRF 校验同一判断);没有 Origin 的非浏览器
      // 客户端照常走下面的登录鉴权。
      const origin = (req.headers["origin"] ?? "").toString();
      if (origin && !isAllowedOrigin(origin, req)) {
        rejectAndClose(socket, 4403, "forbidden_origin", "forbidden_origin", L(req, "跨站请求被拒绝", "Cross-site request rejected"));
        return;
      }
      const sso = req.user;
      if (!sso) {
        rejectAndClose(socket, 4401, "unauthenticated", "unauthenticated", L(req, "请先登录", "Sign in first"));
        return;
      }
      // Mirror requireUser: map the SSO identity to the local user row.
      // The local row is created on the first HTTP request, so by the
      // time a meeting socket opens it normally already exists; if a
      // user somehow opens the socket before any HTTP call, treat the
      // missing local row as unauthenticated rather than JIT-creating
      // here (creation belongs to the HTTP guard).
      // Mirror requireUser's keying: prefer the open_id-anchored row, but
      // also match a legacy cuid-keyed row not yet adopted by the HTTP guard.
      const user = await prisma.user.findFirst({
        where: { ssoId: { in: [sso.open_id, sso.id] } },
        select: { id: true, isActive: true, isAdmin: true, displayName: true },
      });
      if (!user || !user.isActive) {
        rejectAndClose(socket, 4401, "unauthenticated", "unauthenticated", L(req, "请先登录", "Sign in first"));
        return;
      }

      const sessionId = req.params.id;
      const dbSession = await prisma.meetingSession.findUnique({ where: { id: sessionId } });
      if (!dbSession || dbSession.deletedAt != null) {
        rejectAndClose(socket, 4404, "not_found", "not_found", L(req, "会议不存在", "Meeting not found"));
        return;
      }
      if (dbSession.status !== "active") {
        rejectAndClose(socket, 4410, "ended", "ended", L(req, "会议已结束", "The meeting has ended"));
        return;
      }
      // Visibility gate: a private meeting's live stream is creator-only
      // (admins get no bypass — they see it only when they ARE the creator).
      // The host path is the creator so it always passes; this matters for
      // the viewer path, which previously joined any active meeting it knew
      // the id of. allowedRoleIds is NOT consulted here — it's an
      // assistant-retrieval scope only, never an access gate.
      if (!canViewMeeting(user, { visibility: dbSession.visibility, createdById: dbSession.createdById })) {
        rejectAndClose(socket, 4403, "forbidden", "forbidden", L(req, "无权访问该会议", "No permission to access this meeting"));
        return;
      }

      // Decode meeting config. A malformed config falls back to
      // schema defaults — which means recording stays ON (the
      // conservative posture) but trigger settings get the same
      // 5min/silence-on default as a fresh meeting.
      const cfg = meetingConfig(dbSession.config);
      const recordingEnabled = cfg.recording;

      // Decode the meeting's allowedRoleIds (JSON array of strings).
      // assistant retrieval is intersected with this set so a question
      // asked in a product-only meeting doesn't surface unrelated
      // docs even when the asker happens to have wider permissions.
      let allowedRoleIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(dbSession.allowedRoleIds);
        if (Array.isArray(parsed)) allowedRoleIds = parsed.filter((x): x is string => typeof x === "string");
      } catch { /* defensive: empty allowedRoleIds → no role-scope filter */ }

      // Resolve the host's displayName + isAdmin once at upgrade
      // time so the assistant fire path can:
      //   (a) label natural-trigger broadcasts with the host's name
      //   (b) call retrieval with the right isAdmin gate (an admin
      //       host can see private docs others can't — and assistant
      //       should match the host's reach for natural triggers).
      let hostName: string | null = null;
      let hostIsAdmin = false;
      try {
        const host = await prisma.user.findUnique({
          where: { id: dbSession.createdById },
          select: { displayName: true, isAdmin: true },
        });
        hostName = host?.displayName ?? null;
        hostIsAdmin = host?.isAdmin ?? false;
      } catch { /* noop */ }

      const isHost = dbSession.createdById === user.id;
      const state = getOrCreateState(
        sessionId,
        recordingEnabled,
        dbSession.createdAt.getTime(),
        cfg,
        allowedRoleIds,
        dbSession.createdById,
        hostName,
        hostIsAdmin,
      );
      sessionLoggers.set(state, req.log);
      // Once a shutdown is in-flight the channel is going away —
      // reject new connects so we don't add work the shutdown will
      // immediately have to undo.
      if (state.shuttingDown) {
        rejectAndClose(socket, 4410, "ended", "ended", L(req, "会议已结束", "The meeting has ended"));
        return;
      }

      if (isHost) {
        // If a previous host tab is still connected (refresh / 2nd
        // window), evict it. Last-writer-wins matches the user's
        // intuition; the kicked tab gets a clean error frame.
        const prev = state.host;
        if (prev && prev !== socket) {
          sendEvent(prev, { type: "error", code: "host_replaced", message: L(req, "另一个标签接管了主持人位置", "Another tab took over the host seat") });
          try { prev.close(4409, "host_replaced"); } catch { /* noop */ }
        }
        state.host = socket;
        state.hostUserId = user.id;
        state.hostMicMuted = false;
      } else {
        state.viewers.add(socket);
      }

      // pre-warm the STT session for hosts so the FIRST audio
      // chunk doesn't get dropped while we async-resolve credentials
      // from the DB. We AWAIT the open so the "joined" event is the
      // signal that "you can safely start streaming now". For viewers
      // there's nothing to open.
      if (isHost && !state.sttSession && !state.sttFailed) {
        // Kick the background open + await it briefly. ensureSttSession
        // returns null on first call (since session isn't ready) but
        // sets state.sttOpening — we await that.
        ensureSttSession(state, req.log);
        if (state.sttOpening) {
          try { await state.sttOpening; } catch { /* sttFailed flag will be set */ }
        }
      }

      // Greet new connection with their role + current state, then
      // tell everyone the viewer count just changed. Also
      // signal whether the STT pipeline is degraded so the UI can
      // render an amber "识别服务降级" banner without waiting for
      // an error.
      //
      // Degraded fires when EITHER:
      //   - the volc circuit breaker is tripped (creds set, upstream
      //     misbehaving) → temporarily routing to stub
      //   - the resolved provider is the stub itself (no creds
      //     configured at all) → permanently in stub mode until
      //     an admin saves keys in /admin/settings
      // Both cases produce synthetic transcripts the host should
      // not mistake for real ASR.
      let sttDegraded = isVolcBreakerOpen();
      if (!sttDegraded) {
        try {
          const provider = await getSttProvider();
          if (provider.name === "stub") sttDegraded = true;
        } catch { /* if resolve fails, leave sttDegraded as-is */ }
      }
      sendEvent(socket, {
        type: "joined",
        role: isHost ? "host" : "viewer",
        viewerCount: state.viewers.size,
        hostConnected: state.host !== null,
        hostMicMuted: state.hostMicMuted,
        recordingEnabled: state.recordingEnabled,
        sttDegraded,
      });
      broadcastViewerCount(state);

      // Binary frames = audio chunks. Only honor them from the
      // host slot — viewers sending binary is silently ignored
      // (no point disconnecting them; could be a stale client).
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          if (state.host !== socket) {
            // First few mismatches go in the log so we can see if
            // the host slot is being claimed by a different socket
            // than the one sending audio (e.g. a stale reconnect).
            if ((state.chunkCount ?? 0) < 3) {
              req.log.warn({
                event: "meeting.audio.host_mismatch",
                sessionId,
                hasHost: Boolean(state.host),
                isViewerSocket: state.viewers.has(socket),
              }, "binary chunk from non-host socket — dropped");
            }
            return;
          }
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          state.chunkCount += 1;
          state.totalBytes += chunk.byteLength;
          if (state.chunkCount <= 3 || state.chunkCount % 20 === 0) {
            // Visibility into "did the chunk reach the STT branch
            // and what state was the STT session in at the time?"
            // Without this the silent-failure mode is opaque.
            req.log.info({
              event: "meeting.audio.chunk_in",
              sessionId,
              n: state.chunkCount,
              size: chunk.byteLength,
              sttSession: Boolean(state.sttSession),
              sttOpening: Boolean(state.sttOpening),
              sttClosing: Boolean(state.sttClosing),
              sttFailed: state.sttFailed,
              // Diagnostic for "transcript lags behind": bytes stuck in the
              // 火山 send buffer. If this climbs across log lines, audio is
              // outrunning the upstream link (slow link OR client sending
              // faster than realtime). Compare the gap between successive log
              // timestamps to infer chunk rate (~8/s @ 16kHz; ~23/s if the
              // browser ignored the 16kHz request and is sending 48kHz).
              sttBufferedBytes: state.sttSession?.bufferedBytes?.() ?? null,
              // Recognition backlog in ms (audio fed − audio 火山 has recognized).
              // The real "transcript lags behind" signal: send buffer can read 0
              // while this climbs (火山 accepts bytes but recognizes < real time).
              // Crossing STT_RECYCLE_MS recycles the session to the live edge.
              sttLagMs: Math.round(state.sttSession?.lagMs?.() ?? 0),
              sttRecycles: state.sttRecycles,
            }, "audio chunk received");
          }
          try {
            writeChunk(state, chunk, req.log);
          } catch (err) {
            req.log.error({ err: (err as Error).message, sessionId }, "recording write failed");
          }
          // Pipe the same chunk into STT (best-effort; STT failures
          // never block recording). STT session is opened lazily on
          // the first chunk and reused across host reconnects.
          // ensureSttSession returns null when the provider is
          // poisoned — silently drop the chunk in that case rather
          // than flooding logs at chunk rate.
          //
          // sttClosing is set when the host just pressed
          // `recording_stopped` — we synchronously kick off the
          // close, then forward subsequent chunks into a fresh
          // session, queued behind the await so the old session's
          // trailing onFinal can't race ahead of the new session's
          // first onPartial.
          if (state.sttClosing) {
            // Don't eagerly null state.sttClosing — leave it set
            // until the close promise actually resolves. Otherwise
            // chunk N sees the old close-in-flight, chunk N+1
            // (arriving microseconds later) sees state.sttClosing
            // === null and falls through to ensureSttSession,
            // racing the about-to-fire ensureSttSession from
            // chunk N's .then. The single .then() that clears it
            // is the linchpin.
            void state.sttClosing.then(() => {
              if (state.shuttingDown) return;
              state.sttClosing = null;
              const fresh = ensureSttSession(state, req.log);
              pushAudioToStt(state, fresh, chunk, req.log);
            });
            return;
          }
          pushAudioToStt(state, ensureSttSession(state, req.log), chunk, req.log);
          return;
        }
        // Text frames = small JSON control messages.
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof data === "string" ? data : data.toString());
        } catch { return; }
        if (!parsed || typeof parsed !== "object") return;
        const msg = parsed as { type?: unknown; muted?: unknown };
        // `mic_state` from host: viewers can render an "麦克风已静音"
        // banner so they don't think the stream is broken.
        if (msg.type === "mic_state" && state.host === socket) {
          state.hostMicMuted = Boolean(msg.muted);
          broadcastAll(state, { type: "mic_state", muted: state.hostMicMuted });
          return;
        }
        // `recording_stopped`: host fully released the mic (not just
        // muted). Distinct from mic_state so viewers can render a
        // "录制已结束" badge — and so the STT logic can finalize the
        // current transcript segment instead of waiting for more
        // audio that's never coming.
        if (msg.type === "recording_stopped" && state.host === socket) {
          state.hostMicMuted = true;
          broadcastAll(state, { type: "recording_stopped" });
          // Close the STT session so the trailing audio buffered
          // inside the provider becomes a final segment + persists.
          // A subsequent "start recording" press opens a fresh
          // session via ensureSttSession on the next chunk.
          //
          // Stash the close promise on state.sttClosing so the
          // next pushChunk waits for it before creating a fresh
          // session — otherwise the old session's trailing
          // onFinal could fire AFTER the new session's first
          // partial, producing out-of-order transcript events
          // (e.g. partial got wiped by a stale final).
          //
          // Also reset sttFailed so a host who hit a transient
          // provider error can manually retry by clicking "start
          // recording" again.
          if (state.sttSession) {
            const closing = state.sttSession;
            state.sttSession = null;
            state.sttFailed = false;
            state.sttClosing = closing.close().catch(() => { /* noop */ });
          }
          return;
        }
        // `heartbeat`: keepalive ping for environments that close
        // idle WS after 60s (corporate proxies, etc). No response
        // needed — just keeps the socket from going silent.
        if (msg.type === "heartbeat") return;
        // "📢 让助手评论刚才" — manual trigger,
        // host-only at the server level (the UI hides it from
        // non-hosts but a hand-crafted text frame from a viewer
        // would otherwise bypass that). Bypasses freq limit but
        // honors the 20-comment hard cap.
        if (msg.type === "comment_now") {
          if (state.host !== socket) {
            sendEvent(socket, { type: "assistant_skipped", reason: L(req, "仅主持人可使用「评论刚才」", "Only the host can use 'Comment on that'") });
            return;
          }
          if (state.assistantBusy) {
            sendEvent(socket, { type: "assistant_skipped", reason: L(req, `${ASSISTANT_NAME} 正在生成中，请稍后`, `${ASSISTANT_NAME} is generating. Please wait`) });
            return;
          }
          const eng = ensureTriggerEngine(state);
          const decision = eng.evaluateManual("manual_button", Date.now() - state.meetingStartedAtMs);
          if (!decision.fire) {
            sendEvent(socket, { type: "assistant_skipped", reason: decision.reason });
            return;
          }
          void fireAssistantChime(state, {
            trigger: "manual_button",
            askerUserId: user.id,
            askerIsAdmin: Boolean(user.isAdmin),
            askerName: user.displayName,
            // Surface a skip if a concurrent chime claimed assistantBusy between
            // the sync check above and this scheduled fire (otherwise the
            // click vanishes with no feedback).
            onBusySkip: () => sendEvent(socket, { type: "assistant_skipped", reason: L(req, `${ASSISTANT_NAME} 正在生成中，请稍后`, `${ASSISTANT_NAME} is generating. Please wait`) }),
          });
          return;
        }
        // "💬 问助手" — explicit user question. Hard cap
        // (20/meeting) + per-user 10s cooldown so one person
        // can't burn the cap in a burst. Retrieval uses the
        // asker's perms.
        if (msg.type === "ask_assistant") {
          const question = typeof (msg as { question?: unknown }).question === "string"
            ? (msg as { question: string }).question.trim()
            : "";
          if (!question) return;
          // Cap the question length before it flows into the LLM prompt.
          // The ws payload cap (2MB) is far too loose: a multi-KB question
          // bloats the prompt + token cost with no product benefit. Mirror
          // the HTTP chat limit (schemas/chat.ts → .max(4096)) and reject
          // anything longer with the same skip channel the UI already renders.
          const MAX_QUESTION_CHARS = 4096;
          if (question.length > MAX_QUESTION_CHARS) {
            sendEvent(socket, { type: "assistant_skipped", reason: L(req, "问题过长，请精简后再问（上限 4096 字）", "Question too long. Shorten it and ask again (4096 characters maximum)") });
            return;
          }
          // Per-user cooldown — protects the shared LLM budget
          // from one chatty participant. The hard cap is global;
          // this is the per-user fair-share gate.
          const PER_USER_COOLDOWN_MS = 10_000;
          // Per-VIEWER lifetime ask cap. Anti-griefing: the global hard cap is
          // 20/meeting (TriggerEngine), and the 10s cooldown only paces a single
          // user — N viewers could still collectively drain all 20 slots and
          // block the host. Capping each non-host asker at 5 keeps headroom for
          // the host (who is exempt) even with a roomful of viewers. Minimal,
          // deliberately not configurable.
          const PER_VIEWER_ASK_CAP = 5;
          const isHostAsker = state.host === socket || state.hostUserId === user.id;
          const nowMs = Date.now();
          const last = state.lastAskAtByUser.get(user.id) ?? 0;
          if (nowMs - last < PER_USER_COOLDOWN_MS) {
            const left = Math.ceil((PER_USER_COOLDOWN_MS - (nowMs - last)) / 1000);
            sendEvent(socket, { type: "assistant_skipped", reason: L(req, `请等待 ${left}s 再问下一个`, `Wait ${left}s before asking the next one`) });
            return;
          }
          if (!isHostAsker && (state.askCountByUser.get(user.id) ?? 0) >= PER_VIEWER_ASK_CAP) {
            sendEvent(socket, { type: "assistant_skipped", reason: L(req, `你本场提问已达上限（${PER_VIEWER_ASK_CAP} 次）`, `You have reached the question limit for this meeting (${PER_VIEWER_ASK_CAP})`) });
            return;
          }
          if (state.assistantBusy) {
            sendEvent(socket, { type: "assistant_skipped", reason: L(req, `${ASSISTANT_NAME} 正在生成中，请稍后`, `${ASSISTANT_NAME} is generating. Please wait`) });
            return;
          }
          const eng = ensureTriggerEngine(state);
          const decision = eng.evaluateManual("user_question", Date.now() - state.meetingStartedAtMs);
          if (!decision.fire) {
            sendEvent(socket, { type: "assistant_skipped", reason: decision.reason });
            return;
          }
          // Record the timestamp BEFORE firing so a quick double-
          // click is throttled even if the first generation hasn't
          // finished yet.
          state.lastAskAtByUser.set(user.id, nowMs);
          // Count this ask toward the per-viewer lifetime cap (host exempt, so
          // its count is never read — but we skip the write to keep the map
          // free of host entries).
          if (!isHostAsker) {
            state.askCountByUser.set(user.id, (state.askCountByUser.get(user.id) ?? 0) + 1);
          }
          // Opportunistic prune so the Map doesn't accumulate stale
          // entries for users who left long ago. Threshold of 100
          // is way past any plausible per-meeting unique-asker
          // count; once breached, drop everyone whose cooldown has
          // expired (they no longer need the entry).
          if (state.lastAskAtByUser.size > 100) {
            for (const [uid, t] of state.lastAskAtByUser) {
              if (nowMs - t > PER_USER_COOLDOWN_MS) {
                state.lastAskAtByUser.delete(uid);
                // Mirror the prune on askCountByUser so it doesn't grow
                // unbounded either. Only drop entries BELOW the cap — a user
                // who hit PER_VIEWER_ASK_CAP must stay tracked or they'd reset
                // their lifetime allowance just by idling past the cooldown.
                if ((state.askCountByUser.get(uid) ?? 0) < PER_VIEWER_ASK_CAP) {
                  state.askCountByUser.delete(uid);
                }
              }
            }
          }
          void fireAssistantChime(state, {
            trigger: "user_question",
            askerUserId: user.id,
            askerIsAdmin: Boolean(user.isAdmin),
            askerName: user.displayName,
            question,
            // Same busy-race feedback as comment_now: a concurrent chime may
            // claim assistantBusy between the sync check above and this scheduled
            // fire, so tell the asker instead of dropping silently.
            onBusySkip: () => sendEvent(socket, { type: "assistant_skipped", reason: L(req, `${ASSISTANT_NAME} 正在生成中，请稍后`, `${ASSISTANT_NAME} is generating. Please wait`) }),
          });
          return;
        }
      });

      socket.on("close", () => {
        if (state.host === socket) {
          state.host = null;
          state.hostUserId = null;
          broadcastAll(state, { type: "host_disconnected" });
        } else {
          state.viewers.delete(socket);
          broadcastViewerCount(state);
        }
        // If absolutely nobody is connected AND the session is
        // still active (i.e. shutdownMeetingChannel hasn't been
        // called), keep the state around so a host reconnect can
        // resume. We DON'T close the recording stream here — the
        // host may come back; full close happens in shutdown.
      });
    },
  );
}
