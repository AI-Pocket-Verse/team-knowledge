import type { SttProvider, SttSession, SttSessionOpts } from "./types.js";

// process-global circuit breaker around the volc provider.
//
// Why: 火山引擎 STT (or any external streaming ASR) can have brief
// outages — bad day at the data center, auth token rotated, quota
// burnt. Without a breaker, every meeting in flight at that moment
// hits the same upstream error, floods logs, and the host sees
// nothing-but-errors with no clear recovery.
//
// Behavior:
//   - Forward to volc by default.
//   - Wrap onError + ws-close callbacks; count "open failures"
//     (anything that fires before the session ever emits a final).
//   - If `THRESHOLD` failures land within `WINDOW_MS`, flip the
//     breaker open: route NEW sessions to the stub for `COOLDOWN_MS`.
//     Sessions already open keep limping (we don't cancel them).
//   - After cooldown elapses, the breaker closes on the next open()
//     and starts trusting volc again.
//
// The breaker is process-global (module-level state) — not
// per-meeting — since the upstream is shared. Tests reset it via
// `_resetBreakerForTests()`.

const THRESHOLD = 3;
const WINDOW_MS = 60_000;     // 3 FAILED SESSIONS in 60s → trip
const COOLDOWN_MS = 30_000;   // stay open for 30s, then re-try volc

interface BreakerState {
  /** Timestamps of recent open-time failures. */
  errors: number[];
  /** When > 0, breaker is open until this wallclock ms. */
  openedUntil: number;
}

const breaker: BreakerState = { errors: [], openedUntil: 0 };

function breakerIsOpen(now: number): boolean {
  if (breaker.openedUntil > now) return true;
  // Cooldown elapsed — half-close: clear so the next failure starts
  // a fresh window count.
  if (breaker.openedUntil > 0 && breaker.openedUntil <= now) {
    breaker.openedUntil = 0;
    breaker.errors = [];
  }
  return false;
}

function recordError(now: number): void {
  // Drop errors older than the window.
  breaker.errors = breaker.errors.filter((t) => now - t < WINDOW_MS);
  breaker.errors.push(now);
  if (breaker.errors.length >= THRESHOLD) {
    breaker.openedUntil = now + COOLDOWN_MS;
  }
}

export function isVolcBreakerOpen(): boolean {
  return breakerIsOpen(Date.now());
}

export function _resetBreakerForTests(): void {
  breaker.errors = [];
  breaker.openedUntil = 0;
}

export class FallbackSttProvider implements SttProvider {
  // Surface as "volc" to upstream callers — the wrapper is an
  // implementation detail. Tests that want to know which backend
  // a specific session is using read the result of `open()`.
  readonly name = "volc" as const;

  constructor(private volc: SttProvider) {}

  /** True when this provider would degrade the NEXT open() (because the
   *  breaker is currently tripped). Useful for the /joined event so the UI
   *  can render a "degraded" banner. */
  isDegraded(): boolean {
    return isVolcBreakerOpen();
  }

  open(opts: SttSessionOpts): SttSession {
    const now = Date.now();
    if (breakerIsOpen(now)) {
      // 火山 暂时不可用(熔断打开)。Degrade SILENTLY — do NOT fall back to the
      // synthetic stub: its "chunk#N" output would flood the host's transcript
      // with gibberish. Surface a one-shot notice (for a UI banner) and emit no
      // transcript; volc auto-resumes after the cooldown.
      opts.onError(`[degraded] 语音识别暂时不可用，已暂停转录（稍后自动恢复）`);
      // After the cooldown, fire onClosed so the meeting drops this silent
      // session and reopens — re-trying volc once the breaker has half-closed.
      // Without it the silent session would persist forever and never auto-
      // resume. unref so the timer never keeps the process alive.
      const timer = setTimeout(() => opts.onClosed?.("degraded cooldown elapsed"), COOLDOWN_MS);
      timer.unref?.();
      return { pushChunk: () => undefined, close: async () => { clearTimeout(timer); } };
    }

    // Track whether this session ever produced a successful final. Errors
    // before the first final mean we never got past handshake/auth.
    let producedFinal = false;
    // Count at most ONE breaker strike per session. A single bad 火山 session
    // emits an error PER audio chunk (the server ends the session, every
    // subsequent packet re-errors), which would trip the breaker on one
    // transient hiccup. The breaker is for PERSISTENT outages, so it should
    // take repeated FAILED SESSIONS — not one flooding session — to trip.
    let countedError = false;
    const wrappedOpts: SttSessionOpts = {
      ...opts,
      onFinal: (text, startMs, endMs) => {
        producedFinal = true;
        opts.onFinal(text, startMs, endMs);
      },
      onError: (msg) => {
        if (!producedFinal && !countedError) {
          countedError = true;
          recordError(Date.now());
        }
        opts.onError(msg);
      },
    };
    return this.volc.open(wrappedOpts);
  }
}
