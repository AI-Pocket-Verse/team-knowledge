import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingCommentRow, MeetingCommentTrigger } from "@team-knowledge/shared";
import { beijingParts } from "@/lib/tz";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT } from "@/i18n";

// ─── assistant chime-in panel ─────────────────────────────────
// Right-side companion to LiveTranscript. Renders:
//   * assistant comments timeline (chronological, with trigger icon)
//   * "💬 问助手" text input — any participant can ask
//   * "📢 让助手评论刚才" button — host-only (passed via prop)
//   * Last-skipped reason banner (throttled / hard cap / etc)
//   * TTS playing indicator (host-only)

function triggerLabel(t: MeetingCommentTrigger): { icon: string; label: string } {
  switch (t) {
    case "explicit_wake":  return { icon: "🗣️", label: tr("meeting.trigger.explicit_wake") };
    case "keyword":         return { icon: "🔍", label: tr("meeting.trigger.keyword") };
    case "silence":         return { icon: "🤫", label: tr("meeting.trigger.silence") };
    case "proactive":       return { icon: "💡", label: tr("meeting.trigger.proactive") };
    case "manual_button":   return { icon: "📢", label: tr("meeting.trigger.manual_button") };
    case "user_question":   return { icon: "💬", label: tr("meeting.trigger.user_question") };
  }
}

// Render a wall-clock hh:mm label (24h, Beijing time) for an absolute
// epoch-ms instant. Comment `atMs` offsets are added to the meeting
// start before formatting — see `startedAtMs`.
function formatClock(epochMs: number): string {
  const { hour, minute } = beijingParts(new Date(epochMs));
  return `${hour}:${minute}`;
}

// Safety net: if the server never answers (dropped WS, LLM hang), drop
// the "thinking" spinner after this long so it doesn't sit forever.
const PENDING_TIMEOUT_MS = 45_000;

// Speaker (喇叭) glyph for the TTS "播放" affordance — replaces the bare
// 🔊 emoji so it sits on the text baseline and inherits currentColor.
function SpeakerIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

interface Props {
  comments: MeetingCommentRow[];
  /** Wall-clock epoch (ms) of the meeting start = MeetingSession.createdAt.
   *  Comment `atMs` is an offset from this; the rendered time is
   *  `startedAtMs + atMs` formatted as hh:mm. */
  startedAtMs: number;
  /** Server-side reason the last manual trigger was rejected.
   *  Shown as a small toast banner that fades after 6s. */
  lastSkipped: { reason: string; at: number } | null;
  /** Send a user_question to the server. */
  onAsk: (question: string) => void;
  /** True when the caller is the host — exposes the "comment now"
   *  button + the TTS toggle. */
  isHost: boolean;
  /** Host-only: send a comment_now (manual_button) trigger. */
  onCommentNow?: () => void;
  /** Host-only: current state of the TTS toggle. */
  ttsEnabled?: boolean;
  /** Host-only: flip the TTS toggle. */
  onToggleTts?: (next: boolean) => void;
  /** Host-only: id of the currently-playing assistant clip + queue depth. */
  playingId?: string | null;
  queuedCount?: number;
  /** Read-only mode (e.g. the post-meeting summary view): hide the
   *  composer and never show a "thinking" spinner. In this mode the
   *  panel is a static timeline — asking is disabled, so a viewer can't
   *  inject a phantom question that would spin forever. Defaults to
   *  false so the live meeting room (where asking IS allowed) is
   *  unaffected. */
  readOnly?: boolean;
}

// Local echo of "I just asked assistant something" — the WS `ask_assistant`
// message is fire-and-forget and the server doesn't broadcast user
// questions back as comments, so without this the input would just
// vanish on submit and the user wouldn't see their own message until
// (and unless) assistant replied. Each entry remembers how many assistant
// comments existed at the moment it was sent so we can splice it
// into the rendered timeline at a stable position even as new
// comments arrive afterwards.
type UserEcho = {
  id: string;
  text: string;
  sentAtMs: number;
  afterCommentCount: number;
};

export function AssistantPanel({
  comments,
  startedAtMs,
  lastSkipped,
  onAsk,
  isHost,
  onCommentNow,
  ttsEnabled = true,
  onToggleTts,
  playingId = null,
  queuedCount = 0,
  readOnly = false,
}: Props) {
  const t = useT();
  const [input, setInput] = useState("");
  const [skippedVisible, setSkippedVisible] = useState(false);
  const [userMsgs, setUserMsgs] = useState<UserEcho[]>([]);
  // "assistant is thinking" spinner shown between asking and the reply
  // (a new comment) or rejection (assistant_skipped) landing. The baseline
  // snapshots what we'd seen at ask-time so we can detect "something
  // new from assistant" arrived.
  const [pending, setPending] = useState(false);
  const pendingBaselineRef = useRef<{ commentCount: number; skipAt: number | null } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // Auto-fade the "skipped" banner after 6s.
  useEffect(() => {
    if (!lastSkipped) return;
    setSkippedVisible(true);
    const t = window.setTimeout(() => setSkippedVisible(false), 6_000);
    return () => window.clearTimeout(t);
  }, [lastSkipped]);

  // Clear the spinner once assistant responds: either a new comment appended
  // or a fresh assistant_skipped (lastSkipped.at advanced past the baseline).
  useEffect(() => {
    if (!pending) return;
    const base = pendingBaselineRef.current;
    if (!base) return;
    const gotComment = comments.length > base.commentCount;
    const gotSkip = (lastSkipped?.at ?? null) !== base.skipAt;
    if (gotComment || gotSkip) {
      setPending(false);
      pendingBaselineRef.current = null;
    }
  }, [pending, comments.length, lastSkipped]);

  // Safety timeout — never let the spinner hang if the server goes quiet.
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => {
      setPending(false);
      pendingBaselineRef.current = null;
    }, PENDING_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  // Build the rendered timeline. Walk the comments list and interleave
  // each user echo right after the i-th comment where
  // `afterCommentCount === i+1`. Items that were sent before any
  // comment (afterCommentCount=0) land at the very top; items with
  // afterCommentCount > comments.length (shouldn't normally happen)
  // get appended at the tail so nothing is lost.
  type TimelineItem =
    | { kind: "comment"; data: MeetingCommentRow }
    | { kind: "user"; data: UserEcho };
  const timeline: TimelineItem[] = [];
  let echoIdx = 0;
  for (let i = 0; i <= comments.length; i++) {
    while (echoIdx < userMsgs.length && userMsgs[echoIdx]!.afterCommentCount === i) {
      timeline.push({ kind: "user", data: userMsgs[echoIdx]! });
      echoIdx += 1;
    }
    if (i < comments.length) timeline.push({ kind: "comment", data: comments[i]! });
  }
  while (echoIdx < userMsgs.length) {
    timeline.push({ kind: "user", data: userMsgs[echoIdx]! });
    echoIdx += 1;
  }

  // Stick-to-bottom on any new row (comment or user echo), unless the
  // user manually scrolled away. Tracking timeline.length covers both
  // sources without needing two separate effects.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [timeline.length, pending]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 48;
  }

  function submit() {
    // Read-only mode has no composer, but guard here too so nothing can
    // push a UserEcho + pending spinner that would never resolve (onAsk
    // is a noop in the summary view).
    if (readOnly) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    setUserMsgs((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: trimmed,
        sentAtMs: Date.now(),
        afterCommentCount: comments.length,
      },
    ]);
    // Pin to bottom — the user just sent a message, they expect to
    // see it. If they had scrolled away earlier, override that.
    stickRef.current = true;
    // Snapshot what we've seen so the spinner clears on the next
    // assistant comment / skip (whichever lands first).
    pendingBaselineRef.current = { commentCount: comments.length, skipAt: lastSkipped?.at ?? null };
    setPending(true);
    onAsk(trimmed);
    setInput("");
  }

  return (
    <aside className="flex h-full min-h-[20rem] flex-col rounded-xl border border-line bg-white p-4 text-sm shadow-glass">
      <header className="flex items-center justify-between gap-2 pb-3">
        <div className="flex items-center gap-2 font-semibold text-fg">
          <span aria-hidden>💬</span>
          <span>{t("meeting.assistant.comments", { name: getAssistantName() })}</span>
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{comments.length}</span>
        </div>
        {isHost && onToggleTts && (
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={ttsEnabled}
              onChange={(e) => onToggleTts(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            <span className="inline-flex items-center gap-1"><SpeakerIcon />{t("meeting.assistant.play")}</span>
            {playingId && <span className="ml-1 text-emerald-600">{t("meeting.assistant.playing")}</span>}
            {queuedCount > 0 && <span className="ml-1">{t("meeting.assistant.queued", { n: queuedCount })}</span>}
          </label>
        )}
      </header>

      {skippedVisible && lastSkipped && (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          {t("meeting.assistant.skipped", { name: getAssistantName(), reason: lastSkipped.reason })}
        </div>
      )}

      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
      >
        {timeline.length === 0 && !pending ? (
          <div className="flex h-32 items-center justify-center text-center text-xs text-muted">
            {t("meeting.assistant.empty", { name: getAssistantName() })}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {timeline.map((row) => {
              if (row.kind === "user") {
                // User echoes get a right-aligned violet bubble so they
                // visually contrast with assistant's neutral comment cards
                // and read as "what I said" vs "what assistant said".
                const u = row.data;
                return (
                  <li key={u.id} className="flex justify-end">
                    <div className="max-w-[80%] rounded-lg bg-accent-soft px-3 py-2 text-fg shadow-glass">
                      <div className="text-[10px] text-primary/70">{t("meeting.assistant.yourQuestion")}</div>
                      <div className="mt-0.5 whitespace-pre-wrap leading-relaxed">{u.text}</div>
                    </div>
                  </li>
                );
              }
              const c = row.data;
              const trig = triggerLabel(c.triggerType);
              return (
                <li key={c.id} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span aria-hidden>{trig.icon}</span>
                    <span>{trig.label}</span>
                    <span className="tabular-nums">{formatClock(startedAtMs + c.atMs)}</span>
                    {c.triggeredByName && (
                      <>
                        <span>{c.triggeredByName}</span>
                      </>
                    )}
                    {c.id === playingId && (
                      <span className="ml-auto inline-flex items-center gap-1 text-emerald-600"><SpeakerIcon />{t("meeting.assistant.playing")}</span>
                    )}
                  </div>
                  <div className="mt-1.5 whitespace-pre-wrap text-fg leading-relaxed">
                    {c.text}
                    {c.streaming && (
                      // While streaming, show a subtle "正在发言…" cue + a blinking
                      // caret so the growing text reads as live, not stuck.
                      <span className="ml-1 align-baseline text-xs text-blue-500">
                        <span className="animate-pulse">▌</span>
                        <span className="ml-1 text-muted">{t("meeting.assistant.speaking")}</span>
                      </span>
                    )}
                  </div>
                  {c.citedRefs.length > 0 ? (
                    // Clickable doc links after the comment. Open in a new tab
                    // (target=_blank) so a participant reading a reference
                    // doesn't navigate away from the live meeting.
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      <span aria-hidden>📎</span>
                      {c.citedRefs.map((r) => (
                        <Link
                          key={r.articleId}
                          to={`/d/${r.articleId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={r.title}
                          className="max-w-[14rem] truncate text-primary hover:underline"
                        >
                          {t("meeting.docRef", { title: r.title })}
                        </Link>
                      ))}
                      {c.citedArticleIds.length > c.citedRefs.length && (
                        // Some cited docs were deleted (resolved to no title) —
                        // hint at the gap instead of silently dropping them.
                        <span>{t("meeting.assistant.citedDeleted", { n: c.citedArticleIds.length - c.citedRefs.length })}</span>
                      )}
                    </div>
                  ) : c.citedArticleIds.length > 0 ? (
                    // Fallback: ids cited but titles unresolved (e.g. the docs
                    // were deleted after the comment) → show the bare count.
                    <div className="mt-2 text-xs text-muted">{t("meeting.assistant.cited", { n: c.citedArticleIds.length })}</div>
                  ) : null}
                </li>
              );
            })}
            {pending && !readOnly && (
              <li className="flex justify-start" aria-live="polite">
                <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-muted">
                  <span aria-hidden>💬</span>
                  <span className="text-xs">{t("meeting.assistant.thinking", { name: getAssistantName() })}</span>
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400" style={{ animationDelay: "-0.3s" }} />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400" style={{ animationDelay: "-0.15s" }} />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400" />
                  </span>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Composer + host actions. Hidden entirely in read-only mode (the
          post-meeting summary view) so viewers can't type/send a phantom
          question that would never get answered. */}
      {!readOnly && (
        <footer className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Skip Enter that confirms an IME composition (Chinese
                // pinyin etc) — without this, picking a candidate
                // would fire submit and send half-composed text.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={t("meeting.assistant.askPlaceholder", { name: getAssistantName() })}
              className="flex-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-fg outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim()}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg shadow-glass transition enabled:hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("meeting.assistant.send")}
            </button>
          </div>
          {isHost && onCommentNow && (
            <button
              type="button"
              onClick={onCommentNow}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-muted transition hover:bg-surface hover:text-fg"
            >
              {t("meeting.assistant.invite", { name: getAssistantName() })}
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}
