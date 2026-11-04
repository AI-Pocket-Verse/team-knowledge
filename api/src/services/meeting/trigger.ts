import type { MeetingCommentTrigger, MeetingConfig } from "@team-knowledge/shared";
import { env } from "../../env.js";
import { buildWakeWordRegex } from "../../utils/assistant.js";

// ─── Trigger engine ───────────────────────────────────────
// Decides whether assistant should chime in given:
//   * The rolling window of recent finalized transcripts.
//   * The currently-active partial (we lean on it for "is anyone
//     even talking right now").
//   * The meeting's config (freqLimit, triggerSilence, triggerKeyword).
//
// Four natural triggers (in priority order):
//   1. EXPLICIT WAKE — someone said a configured wake word (WAKE_WORDS) in transcript.
//      No cooldown, no LLM judge — assistant responds immediately.
//   2. KEYWORD — text contains "我们以前/上次/那个文档" style
//      references. Cheap regex match → suggests assistant MIGHT be
//      useful; the speaker still calls an LLM-judge before
//      actually generating to avoid spurious chimes. (For now we
//      skip the LLM judge for simplicity; can add later.)
//   3. SILENCE — 12s+ since the last final AND the most recent
//      sentence looked like an open question (ends with ?/吗/嘛).
//   4. PROACTIVE — enough NEW discussion has accrued since assistant's
//      last comment (≥6 new finals OR ≥45s of speech). Fires an
//      unprompted comment grounded in the KB so assistant participates
//      in a normal meeting without anyone asking. Has its own ≥60s
//      cadence so it can't spam, independent of the keyword/silence
//      freqLimit throttle.
//
// Throttling rules:
//   * Natural triggers (keyword + silence) are throttled by
//     config.freqLimitMinutes.
//   * PROACTIVE uses its OWN cadence (PROACTIVE_MIN_CADENCE_MS),
//     not the freqLimit throttle, so it stays lively even when the
//     freqLimit is conservative.
//   * EXPLICIT WAKE + manual buttons + user "ask assistant" bypass
//     throttling (the user explicitly asked).
//   * Hard cap: 20 comments per meeting (across ALL trigger
//     types). After that, even manual asks are rejected with a
//     friendly error.
//
// The engine is stateful per meeting (mirrors how it's invoked
// from meeting-ws.ts). Create one TriggerEngine per session.

// Lowered from 30s → 12s so a normal lull (someone pausing to think,
// waiting on an answer) is enough to bring assistant in.
const SILENCE_TRIGGER_GAP_MS = 12_000;
const ROLLING_WINDOW_MS = 60_000;

// Per-meeting comment budget. The old FIXED cap of 20 made assistant go silent
// partway through a normal meeting (you hit 20 in ~20min of proactive chime).
// The budget now SCALES with meeting length so a short meeting still can't be
// spammed but a long one stays lively. It is a runaway BACKSTOP only — the real
// pacing comes from the proactive cadence (≥60s) + the freqLimit throttle; this
// just stops a bug (or a wake-word loop) from chiming without bound.
//   cap(t) = min(MAX, BASE + floor(elapsedMinutes * PER_MINUTE))
const COMMENT_CAP_BASE = 30;        // floor — budget available from minute 0
const COMMENT_CAP_PER_MINUTE = 3;   // +budget per elapsed meeting-minute
const COMMENT_CAP_MAX = 400;        // absolute backstop against a runaway loop

// Proactive accrual thresholds — fire once EITHER enough new finals
// OR enough new speech-time has piled up since the last assistant comment.
const PROACTIVE_MIN_NEW_FINALS = 6;
const PROACTIVE_MIN_NEW_SPEECH_MS = 45_000;
// Independent minimum gap between two PROACTIVE comments so the
// proactive path can't spam even when discussion is dense.
const PROACTIVE_MIN_CADENCE_MS = 60_000;

// 唤醒词来自环境变量 WAKE_WORDS（默认「小助手」，逗号分隔），`@?` 让「@唤醒词」也能命中。
// 唤醒闸门故意放宽：误唤醒只多一次插话，漏掉才更糟。
const WAKE_WORD_REGEX = buildWakeWordRegex(env.WAKE_WORDS);

// Phrases that suggest the speaker is referring back to historical
// context worth looking up in the knowledge base. Cheap regex —
// future iterations could replace with embedding similarity.
// Broadened to cover more natural Chinese references to past
// decisions / docs / plans / open questions, while still avoiding
// trivially-common words (we anchor on multi-word reference phrases,
// not bare "文档" / "方案").
const KEYWORD_REGEX = /(我们(以前|之前|上次|当时|原来|当初)|(之前|以前|上次|当时|原来|当初)(说|定|讨论|提到|聊|做)(过|的)?|那(个|份|次)(文档|方案|设计|讨论|计划|需求|决定|结论)|(之前|当时)的(决定|结论|方案|计划|文档)|记得吗|还记得|好像是|忘了具体|查一下|查查|有没有(相关|对应|记录|文档)|知识库(里|中)?|大家.{0,10}(决定|定了|商量)|是怎么(定|说|决定)的)/;

// Question-ish endings — used to gate silence trigger so we don't
// chime in during natural pauses after a statement. Both Latin "?"
// and full-width "?" need to be character-class members (full-width
// "?" is not a regex quantifier in JS, but it confuses some
// parsers when placed loose in an alternation).
const QUESTION_TAIL_REGEX = /([??]|吗|嘛|呢|对吗|是吗|对不对|好不好)\s*$/;

export interface TranscriptEntry {
  text: string;
  endMs: number;
}

export type TriggerDecision =
  | { fire: false; reason: string }
  | { fire: true; trigger: MeetingCommentTrigger; reason: string };

export class TriggerEngine {
  private readonly window: TranscriptEntry[] = [];
  // Sliding-window throttle: timestamps of recent natural-trigger
  // comments, kept in chronological order. checkThrottle prunes to
  // the freqLimitMinutes lookback and rejects when the surviving
  // count would meet/exceed freqLimitMessages.
  private readonly commentTimestamps: number[] = [];
  private commentCount = 0;

  // ─── Proactive accrual bookkeeping ───
  // New finals + new speech-time accumulated since the LAST comment
  // (of any kind). Reset by recordComment so the proactive trigger
  // measures "fresh discussion since assistant last spoke", not lifetime.
  private newFinalsSinceComment = 0;
  private newSpeechMsSinceComment = 0;
  // When the last PROACTIVE comment fired (ms offset). -Infinity so
  // the very first proactive eval isn't blocked by the cadence gate.
  private lastProactiveAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: MeetingConfig,
    private readonly meetingStartedAtMs: number,
  ) {}

  /** Notify the engine that a new finalized transcript landed.
   *  Updates the rolling window and returns a decision: should
   *  assistant chime in right now? */
  onTranscriptFinal(entry: TranscriptEntry): TriggerDecision {
    // Accrue proactive metrics BEFORE pruning the window. We measure
    // new speech-time as the gap covered by this segment relative to
    // the prior one (endMs delta), clamped to >= 0 so STT timestamp
    // skew can't push the accrual negative.
    const prev = this.window[this.window.length - 1];
    this.newFinalsSinceComment += 1;
    if (prev) this.newSpeechMsSinceComment += Math.max(0, entry.endMs - prev.endMs);

    this.window.push(entry);
    this.pruneWindow(entry.endMs);

    const cap = this.commentCap(entry.endMs);
    if (this.commentCount >= cap) {
      return { fire: false, reason: `comment cap (${cap}) reached` };
    }
    // 1. EXPLICIT WAKE — always bypasses throttle.
    if (WAKE_WORD_REGEX.test(entry.text)) {
      return { fire: true, trigger: "explicit_wake", reason: "wake word matched" };
    }
    // 2. KEYWORD — throttled.
    if (this.config.triggerKeyword && KEYWORD_REGEX.test(entry.text)) {
      const throttle = this.checkThrottle(entry.endMs);
      if (throttle) return { fire: false, reason: throttle };
      return { fire: true, trigger: "keyword", reason: "keyword pattern matched" };
    }
    // Silence trigger is evaluated by a separate ticker (see
    // evaluateSilence) — not on every transcript_final.
    return { fire: false, reason: "no natural trigger" };
  }

  /** Called periodically by a server-side timer; checks whether
   *  the conversation has stalled on an unanswered question and
   *  assistant should jump in. Returns null when nothing to do. */
  evaluateSilence(nowMs: number): TriggerDecision {
    if (!this.config.triggerSilence) return { fire: false, reason: "silence trigger disabled" };
    if (this.commentCount >= this.commentCap(nowMs)) return { fire: false, reason: "comment cap reached" };
    const last = this.window[this.window.length - 1];
    if (!last) return { fire: false, reason: "no transcripts yet" };
    // Clamp to >= 0 so STT timestamp skew (provider reporting an
    // endMs slightly ahead of our wall clock) can't produce a
    // negative gap that bypasses the threshold check entirely.
    const gap = Math.max(0, nowMs - last.endMs);
    if (gap < SILENCE_TRIGGER_GAP_MS) return { fire: false, reason: `gap ${gap}ms < threshold` };
    if (!QUESTION_TAIL_REGEX.test(last.text)) return { fire: false, reason: "last sentence not an open question" };
    const throttle = this.checkThrottle(nowMs);
    if (throttle) return { fire: false, reason: throttle };
    return { fire: true, trigger: "silence", reason: "silence + open question" };
  }

  /** Called by the same periodic timer as evaluateSilence. Fires a
   *  PROACTIVE comment once enough fresh discussion has accrued since
   *  assistant last spoke, subject to its OWN minimum cadence (not the
   *  freqLimit throttle). The hard cap still applies as the runaway
   *  backstop. Returns null-equivalent (fire:false) when nothing to do. */
  evaluateProactive(nowMs: number): TriggerDecision {
    if (!this.config.triggerProactive) return { fire: false, reason: "proactive trigger disabled" };
    if (this.commentCount >= this.commentCap(nowMs)) return { fire: false, reason: "comment cap reached" };
    if (this.window.length === 0) return { fire: false, reason: "no transcripts yet" };
    // Own cadence gate — keeps proactive comments at least
    // PROACTIVE_MIN_CADENCE_MS apart regardless of accrual speed.
    const sinceLast = nowMs - this.lastProactiveAtMs;
    if (sinceLast < PROACTIVE_MIN_CADENCE_MS) {
      return { fire: false, reason: `proactive cadence ${sinceLast}ms < ${PROACTIVE_MIN_CADENCE_MS}ms` };
    }
    const enoughFinals = this.newFinalsSinceComment >= PROACTIVE_MIN_NEW_FINALS;
    const enoughSpeech = this.newSpeechMsSinceComment >= PROACTIVE_MIN_NEW_SPEECH_MS;
    if (!enoughFinals && !enoughSpeech) {
      return { fire: false, reason: `not enough new discussion (${this.newFinalsSinceComment} finals / ${this.newSpeechMsSinceComment}ms)` };
    }
    // NOTE: we do NOT stamp lastProactiveAtMs here. The decision can still bail
    // downstream (fireAssistantChime sees assistantBusy / shutdown / a saturated LLM
    // cap / retrieval failure) and never actually speak. Stamping the cadence
    // optimistically here would then block the proactive trigger for the full
    // PROACTIVE_MIN_CADENCE_MS even though assistant said nothing. Instead the
    // cadence is stamped in recordComment, which runs ONLY after a comment
    // genuinely started. The caller serializes via assistantBusy, so no second
    // proactive eval can fire while this one's generation is in flight.
    return { fire: true, trigger: "proactive", reason: enoughFinals ? "≥6 new finals accrued" : "≥45s new speech accrued" };
  }

  /** Always-fire path for explicit manual triggers (host pressed
   *  "comment now" or any participant asked assistant directly).
   *  Honors the comment cap but bypasses freqLimit. `nowMs` is the
   *  elapsed offset since meeting start (same base as the other
   *  evaluators) so the cap scales with meeting length. */
  evaluateManual(kind: "manual_button" | "user_question", nowMs: number): TriggerDecision {
    const cap = this.commentCap(nowMs);
    if (this.commentCount >= cap) {
      return { fire: false, reason: `comment cap (${cap}) reached` };
    }
    return { fire: true, trigger: kind, reason: "manual" };
  }

  /** Called after a comment is successfully generated so the next
   *  evaluation can honor the sliding-window throttle + the hard cap. */
  recordComment(atMs: number): void {
    this.commentTimestamps.push(atMs);
    this.commentCount += 1;
    // Reset proactive accrual: "fresh discussion since assistant last spoke"
    // restarts after every comment (of any trigger type), so the next
    // proactive chime waits for genuinely new discussion.
    this.newFinalsSinceComment = 0;
    this.newSpeechMsSinceComment = 0;
    // Stamp the proactive cadence here (NOT in evaluateProactive) so a
    // proactive decision that fired but then bailed before speaking (assistantBusy
    // / shutdown / saturated LLM cap / retrieval failure) never blocks the next
    // proactive eval for the full cadence even though assistant said nothing. Any
    // comment of any type also defers the next proactive chime by the cadence —
    // desirable, since assistant just spoke.
    this.lastProactiveAtMs = atMs;
  }

  /** Snapshot of the rolling window — useful for the speaker
   *  prompt (gives the LLM the recent context). */
  recentTranscriptText(): string {
    return this.window.map((e) => e.text).join(" ");
  }

  /** Test / observability helpers. */
  _state(): { commentCount: number; recentCommentCount: number; windowSize: number } {
    return { commentCount: this.commentCount, recentCommentCount: this.commentTimestamps.length, windowSize: this.window.length };
  }

  /** Per-meeting comment budget at the given elapsed offset (ms since
   *  meeting start). Scales with meeting length — see the COMMENT_CAP_*
   *  constants. Floors negative offsets to 0 so STT timestamp skew can't
   *  shrink the budget below the base. */
  private commentCap(elapsedMs: number): number {
    const mins = Math.max(0, elapsedMs) / 60_000;
    return Math.min(COMMENT_CAP_MAX, COMMENT_CAP_BASE + Math.floor(mins * COMMENT_CAP_PER_MINUTE));
  }

  private pruneWindow(nowMs: number): void {
    const cutoff = nowMs - ROLLING_WINDOW_MS;
    while (this.window.length > 0 && this.window[0]!.endMs < cutoff) {
      this.window.shift();
    }
  }

  private checkThrottle(nowMs: number): string | null {
    // Drop comments outside the sliding window first so the count
    // below only reflects "recent" activity. Old comments that
    // pre-date the lookback have already aged out of the throttle.
    const windowMs = this.config.freqLimitMinutes * 60_000;
    const cutoff = nowMs - windowMs;
    while (this.commentTimestamps.length > 0 && this.commentTimestamps[0]! < cutoff) {
      this.commentTimestamps.shift();
    }
    // `freqLimitMessages ?? 1` lets older persisted MeetingConfig
    // JSON (saved before this field existed) keep working — schema
    // default fills new payloads, but DB rows from before the
    // upgrade may still come back without it.
    const limit = this.config.freqLimitMessages ?? 1;
    if (this.commentTimestamps.length >= limit) {
      return `throttled (${this.commentTimestamps.length}/${limit} comments in last ${this.config.freqLimitMinutes}min)`;
    }
    return null;
  }
}
