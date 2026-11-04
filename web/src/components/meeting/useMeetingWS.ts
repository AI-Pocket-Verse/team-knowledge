import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingCommentRow, MeetingTranscriptRow } from "@team-knowledge/shared";
import { API_BASE } from "@/lib/api";

// State broadcast from the server. Mirrors the event shapes in
// api/src/routes/meeting-ws.ts. We keep both ends as plain
// objects (no shared schema yet) since the surface is small and
// stable.
export type MeetingRole = "host" | "viewer";

// Currently-active partial transcript shown ahead of any finalized
// segments. The server replaces it whenever a new partial arrives;
// when the segment finalizes, the server emits transcript_final
// and we move the text into `transcripts`.
export interface ActivePartial {
  text: string;
  atMs: number;
}

// One streamed assistant TTS clip (a single sentence). Emitted by the
// server `assistant_comment_tts` event as each sentence finishes
// synthesizing while the rest of the comment text is still streaming.
// The host-only playback queue plays these FIFO by arrival order so
// sentence 0 starts talking before the full comment has streamed in.
export interface AssistantTtsChunk {
  commentId: string;
  seq: number;
  audioUrl: string;
}

export interface MeetingWSState {
  /** Connection lifecycle. Renders the live UI when "open".
   *  "reconnecting" = transient close, retrying with backoff. */
  status: "connecting" | "open" | "reconnecting" | "closed" | "error";
  /** Set after the server sends `joined`. Tells the page whether
   *  to render host controls or read-only viewer UI. */
  role: MeetingRole | null;
  /** Live count of read-only viewers (excluding host). */
  viewerCount: number;
  /** True while a host has the audio slot open. Viewers use this
   *  to show "等待主持人加入麦克风" vs "主持人正在讲话". */
  hostConnected: boolean;
  hostMicMuted: boolean;
  /** True when the server confirms recording is enabled for this
   *  meeting (echoed in the `joined` frame). Lets the UI surface
   *  "🔴 录制中" vs "未录制" honestly even if the host disabled it. */
  recordingEnabled: boolean;
  /** Becomes true when the host ends the meeting (or any error
   *  closes the channel). UI flips to the post-meeting summary
   *  view at that point. */
  sessionEnded: boolean;
  /** Last server-sent error message, or a translated close reason. */
  lastError: string | null;
  /** Persisted final transcript segments, oldest first. Hydrated
   *  from /api/meeting/:id on first load; appended via
   *  transcript_final WS events thereafter. */
  transcripts: MeetingTranscriptRow[];
  /** The in-flight partial (server's current best guess for the
   *  segment being spoken right now). Replaced wholesale on every
   *  transcript_partial event; cleared when the segment finalizes
   *  via transcript_final. */
  activePartial: ActivePartial | null;
  /** assistant chimes that have happened so far in the session. Same
   *  pattern as `transcripts`: hydrated from REST, then driven live by
   *  the `assistant_comment_start`/`_delta`/`_done` streaming sequence.
   *  Most recent last. A row with `streaming:true` is mid-generation. */
  comments: MeetingCommentRow[];
  /** Streamed per-sentence assistant TTS clips, in server arrival order.
   *  The host-only TTS queue (useAssistantTtsQueue) drains this FIFO. Grows
   *  for the session; the queue tracks which it has already played. */
  assistantTtsChunks: AssistantTtsChunk[];
  /** Most recent reason the server refused to fire assistant (throttle
   *  hit / hard-cap / etc). The panel surfaces this so the user
   *  knows the click had an effect. Cleared on next successful
   *  fire. */
  lastAssistantSkipped: { reason: string; at: number } | null;
  /** server-side STT circuit breaker is currently tripped —
   *  meeting is using the local stub instead of 火山. UI shows a
   *  small banner so the host knows transcript quality is degraded. */
  sttDegraded: boolean;
}

export interface MeetingWS {
  state: MeetingWSState;
  /** Push a binary audio chunk (host only). No-op for viewers and
   *  while the socket isn't OPEN — the audio recorder calls this
   *  every 500ms whether or not we're connected, so silent drop
   *  is the right default. */
  sendBinary: (buf: ArrayBuffer | Blob) => void;
  /** Push a small JSON control message (host only). Currently used
   *  for `mic_state` / `recording_stopped` / `heartbeat`. */
  sendText: (event: Record<string, unknown>) => void;
  /** explicit ask — any participant types a question. The
   *  server uses the asker's team-knowledge perms for retrieval. */
  askAssistant: (question: string) => void;
  /** "comment on what was just said" — usually wired to a
   *  host/admin button. */
  commentNow: () => void;
}

const INITIAL: MeetingWSState = {
  status: "connecting",
  role: null,
  viewerCount: 0,
  hostConnected: false,
  hostMicMuted: false,
  recordingEnabled: true,
  sessionEnded: false,
  lastError: null,
  transcripts: [],
  activePartial: null,
  comments: [],
  assistantTtsChunks: [],
  lastAssistantSkipped: null,
  sttDegraded: false,
};

// Close-code policy:
//   * Auth / not-found / ended / host-replaced → final, don't retry
//   * Anything else (including 1006 abnormal) → retry with backoff
const NON_RETRYABLE = new Set<number>([4401, 4403, 4404, 4410, 4409]);

const HEARTBEAT_INTERVAL_MS = 30_000;
// Idle expiry for the live partial: on an STT recycle (or any provider hiccup)
// a partial can be abandoned with no transcript_final ever arriving, pinning a
// stale half-sentence forever. If no partial update lands for this long, drop
// it. 6s comfortably exceeds the normal partial cadence (~2 Hz during speech),
// so this never clears a live partial mid-sentence — only orphaned ones.
const PARTIAL_IDLE_TIMEOUT_MS = 6_000;
const MAX_RECONNECT_ATTEMPTS = 5;
// Exponential backoff caps at 8s so a flapping network doesn't
// stall forever — 5 attempts → 1s, 2s, 4s, 8s, 8s.
function backoffDelay(attempt: number): number {
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

// Translate the WS close code we use server-side into UI-friendly
// text. Anything outside the meeting code range falls back to a
// generic "连接已关闭".
function closeReason(code: number, reason: string): string {
  switch (code) {
    case 4401: return "请先登录后再加入会议";
    case 4403: return "无权访问该会议";
    case 4404: return "会议不存在或已删除";
    case 4410: return "会议已结束";
    case 4409: return reason === "host_replaced" ? "另一个标签接管了主持人位置" : "连接被替换";
    case 1000: return reason === "session_ended" ? "会议已结束" : "";
    default:   return "";
  }
}

// Subscribe a React component to the meeting's WebSocket channel.
// Connects on mount when `sessionId` is truthy; disconnects on
// unmount or when `sessionId` becomes null. We deliberately
// re-open from scratch when `sessionId` changes so navigating
// between meetings doesn't leak the old socket.
//
// Resilience:
//   * Sends a heartbeat text frame every 30s while OPEN so corporate
//     proxies don't kill the socket as "idle". Viewers have no
//     outbound binary traffic, so without this they'd drop after ~60s.
//   * Auto-reconnects with exponential backoff (up to 5 attempts)
//     on non-final close codes. Auth / not-found / ended / host-
//     replaced are terminal — no point retrying those.
export function useMeetingWS(
  sessionId: string | null,
  initialTranscripts: MeetingTranscriptRow[] = [],
  initialComments: MeetingCommentRow[] = [],
): MeetingWS {
  const [state, setState] = useState<MeetingWSState>(() => ({
    ...INITIAL,
    transcripts: initialTranscripts,
    comments: initialComments,
  }));
  const wsRef = useRef<WebSocket | null>(null);
  // Idle timer that expires an orphaned live partial (no final ever arrives,
  // e.g. on an STT recycle). Reset on each partial, cleared on final.
  const partialIdleTimerRef = useRef<number | null>(null);
  // Keep the latest initial transcripts + comments in refs so we
  // don't blow away the live-appended ones every render. Only
  // re-seed when the sessionId changes (i.e. the user navigates
  // between meetings).
  const initialTranscriptsRef = useRef(initialTranscripts);
  initialTranscriptsRef.current = initialTranscripts;
  const initialCommentsRef = useRef(initialComments);
  initialCommentsRef.current = initialComments;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;

    function clearHeartbeat() {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function clearPartialIdleTimer() {
      if (partialIdleTimerRef.current !== null) {
        window.clearTimeout(partialIdleTimerRef.current);
        partialIdleTimerRef.current = null;
      }
    }

    // (Re)arm the idle timer that drops a stale partial if no further partial
    // or final arrives. Called on every partial; the final handler clears it.
    function armPartialIdleTimer() {
      clearPartialIdleTimer();
      partialIdleTimerRef.current = window.setTimeout(() => {
        partialIdleTimerRef.current = null;
        setState((s) => (s.activePartial ? { ...s, activePartial: null } : s));
      }, PARTIAL_IDLE_TIMEOUT_MS);
    }

    function connect(): void {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        status: attempt === 0 ? "connecting" : "reconnecting",
        lastError: attempt === 0 ? null : s.lastError,
      }));

      // ws://… or wss://… based on current page scheme. We rely on
      // the cookie session (vite proxies /api so cookies forward
      // intact in dev; in prod the WS endpoint is same-origin).
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}${API_BASE}/meeting/${sessionId}/stream`;
      if (import.meta.env.DEV) console.log("[meeting] ws connect", { url: wsUrl, attempt });
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (import.meta.env.DEV) console.log("[meeting] ws open");
        attempt = 0; // Reset backoff on any successful upgrade.
        setState((s) => ({ ...s, status: "open", lastError: null }));
        // Start heartbeat ticker — server accepts {type:"heartbeat"}
        // text frames and replies with nothing (just keeps the
        // socket from looking idle to proxies).
        clearHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try { ws.send(JSON.stringify({ type: "heartbeat" })); } catch { /* noop */ }
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onmessage = (ev) => {
        // The server only emits JSON text frames to clients; binary
        // is one-way (host → server, never server → client). Anything
        // non-string here is unexpected and silently ignored.
        if (typeof ev.data !== "string") return;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(ev.data) as Record<string, unknown>; } catch { return; }
        // Only log low-frequency control/assistant events. The transcript stream
        // (partial/final) fires tens of times per second during active speech —
        // logging every one floods the console and, with DevTools open,
        // serializing each object can pin the main thread and freeze the
        // transcript view. Heartbeat/viewer_count are chatty noise too.
        if (
          msg.type !== "heartbeat" && msg.type !== "viewer_count" &&
          msg.type !== "transcript_partial" && msg.type !== "transcript_final" &&
          // assistant streaming deltas + per-sentence tts fire many times per
          // comment — same flooding concern as the transcript stream.
          msg.type !== "assistant_comment_delta" && msg.type !== "assistant_comment_tts"
        ) {
          if (import.meta.env.DEV) console.log("[meeting] ws msg", msg);
        }

        switch (msg.type) {
          case "joined": {
            setState((s) => ({
              ...s,
              role: (msg.role as MeetingRole) ?? null,
              viewerCount: typeof msg.viewerCount === "number" ? msg.viewerCount : 0,
              hostConnected: Boolean(msg.hostConnected),
              hostMicMuted: Boolean(msg.hostMicMuted),
              recordingEnabled: typeof msg.recordingEnabled === "boolean" ? msg.recordingEnabled : s.recordingEnabled,
              sttDegraded: Boolean(msg.sttDegraded),
            }));
            return;
          }
          case "viewer_count": {
            setState((s) => ({
              ...s,
              viewerCount: typeof msg.count === "number" ? msg.count : s.viewerCount,
            }));
            return;
          }
          case "mic_state": {
            setState((s) => ({ ...s, hostMicMuted: Boolean(msg.muted) }));
            return;
          }
          case "recording_stopped": {
            // Fully stopped (not just muted) — treat as muted in the
            // UI while still surfacing the distinction to consumers
            // that opt into it later.
            setState((s) => ({ ...s, hostMicMuted: true }));
            return;
          }
          case "host_disconnected": {
            setState((s) => ({ ...s, hostConnected: false }));
            return;
          }
          case "session_ended": {
            // Server-side initiated end. Reflect it locally so the
            // page can swap to summary mode without waiting for a
            // refetch round-trip. The close that follows will be
            // marked non-retryable by checking sessionEnded.
            setState((s) => ({ ...s, sessionEnded: true }));
            return;
          }
          case "transcript_partial": {
            const text = typeof msg.text === "string" ? msg.text : "";
            const atMs = typeof msg.atMs === "number" ? msg.atMs : 0;
            if (!text) return;
            setState((s) => ({ ...s, activePartial: { text, atMs } }));
            // Re-arm the idle timer: a live partial keeps the line pinned,
            // but an abandoned one (no follow-up partial/final) expires.
            armPartialIdleTimer();
            return;
          }
          case "assistant_comment_start": {
            // Streaming begins. Append an empty, streaming:true row that
            // deltas fill in. Server already created the DB row.
            const id = typeof msg.id === "string" ? msg.id : `tmp-${Date.now()}`;
            const triggerType = typeof msg.triggerType === "string" ? (msg.triggerType as MeetingCommentRow["triggerType"]) : "manual_button";
            const triggeredByUserId = typeof msg.triggeredByUserId === "string" ? msg.triggeredByUserId : null;
            const triggeredByName = typeof msg.triggeredByName === "string" ? msg.triggeredByName : null;
            const atMs = typeof msg.atMs === "number" ? msg.atMs : 0;
            const row: MeetingCommentRow = {
              id, triggerType, triggeredByUserId, triggeredByName,
              text: "", citedArticleIds: [], citedRefs: [], ttsAudioUrl: null, atMs,
              createdAt: typeof msg.createdAt === "string" ? msg.createdAt : new Date().toISOString(),
              streaming: true,
            };
            setState((s) => {
              if (s.comments.some((c) => c.id === row.id)) return { ...s, lastAssistantSkipped: null };
              return { ...s, comments: [...s.comments, row], lastAssistantSkipped: null };
            });
            return;
          }
          case "assistant_comment_delta": {
            // Append a token/batch to the matching streaming row by id.
            const id = typeof msg.id === "string" ? msg.id : "";
            const text = typeof msg.text === "string" ? msg.text : "";
            if (!id || !text) return;
            setState((s) => ({
              ...s,
              comments: s.comments.map((c) =>
                c.id === id ? { ...c, text: c.text + text } : c,
              ),
            }));
            return;
          }
          case "assistant_comment_tts": {
            // Enqueue a per-sentence clip for the host TTS queue. Kept in
            // arrival order so playback is FIFO across comments + seq.
            const commentId = typeof msg.id === "string" ? msg.id : "";
            const seq = typeof msg.seq === "number" ? msg.seq : 0;
            const audioUrl = typeof msg.audioUrl === "string" ? msg.audioUrl : "";
            if (!commentId || !audioUrl) return;
            setState((s) => ({
              ...s,
              assistantTtsChunks: [...s.assistantTtsChunks, { commentId, seq, audioUrl }],
            }));
            return;
          }
          case "assistant_comment_done": {
            // Finalize: set the full text + citations + clear streaming.
            const id = typeof msg.id === "string" ? msg.id : "";
            const text = typeof msg.text === "string" ? msg.text : "";
            const citedArticleIds = Array.isArray(msg.citedArticleIds)
              ? (msg.citedArticleIds as unknown[]).filter((x): x is string => typeof x === "string")
              : [];
            // citedRefs (id + title) drive the clickable doc links. Parse
            // defensively — each entry must be a {articleId, title} string pair.
            const citedRefs = Array.isArray(msg.citedRefs)
              ? (msg.citedRefs as unknown[]).flatMap((r) => {
                  const o = r as { articleId?: unknown; title?: unknown };
                  return typeof o?.articleId === "string" && typeof o?.title === "string"
                    ? [{ articleId: o.articleId, title: o.title }]
                    : [];
                })
              : [];
            if (!id) return;
            setState((s) => ({
              ...s,
              comments: s.comments.map((c) =>
                c.id === id ? { ...c, text: text || c.text, citedArticleIds, citedRefs, streaming: false } : c,
              ),
            }));
            return;
          }
          case "assistant_skipped": {
            const reason = typeof msg.reason === "string" ? msg.reason : "throttled";
            setState((s) => ({ ...s, lastAssistantSkipped: { reason, at: Date.now() } }));
            return;
          }
          case "transcript_final": {
            const id = typeof msg.id === "string" ? msg.id : `tmp-${Date.now()}`;
            const text = typeof msg.text === "string" ? msg.text : "";
            const startMs = typeof msg.startMs === "number" ? msg.startMs : 0;
            const endMs = typeof msg.endMs === "number" ? msg.endMs : startMs;
            if (!text) return;
            // Segment finalized — the partial is now superseded, so stop the
            // idle timer (the setState below clears activePartial directly).
            clearPartialIdleTimer();
            const row: MeetingTranscriptRow = {
              id, text, startMs, endMs, speaker: null, createdAt: new Date().toISOString(),
            };
            setState((s) => {
              // De-dupe by id in case the server replays + we
              // hydrated the same row from REST.
              if (s.transcripts.some((t) => t.id === row.id)) {
                return { ...s, activePartial: null };
              }
              return { ...s, transcripts: [...s.transcripts, row], activePartial: null };
            });
            return;
          }
          case "error": {
            const message = typeof msg.message === "string" ? msg.message : "连接异常";
            setState((s) => ({ ...s, status: "error", lastError: message }));
            return;
          }
        }
      };

      ws.onerror = (ev) => {
        // Browser fires `error` then `close` for most failure modes;
        // we only set the status here, the readable reason comes
        // from the close handler below.
        console.warn("[meeting] ws error", ev);
        setState((s) => (s.status === "open" || s.status === "error" ? s : { ...s, status: "error" }));
      };

      ws.onclose = (ev) => {
        clearHeartbeat();
        wsRef.current = null;

        // Two terminal cases we shouldn't retry:
        //  1. Server told us "session_ended" right before close.
        //  2. Close code in the NON_RETRYABLE set (auth/404/410/etc).
        const text = closeReason(ev.code, ev.reason);
        const sessionEndedNow = ev.code === 4410 || (ev.code === 1000 && ev.reason === "session_ended");
        const terminal = NON_RETRYABLE.has(ev.code) || sessionEndedNow;
        if (import.meta.env.DEV) {
          console.log("[meeting] ws close", {
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
            terminal,
            sessionEndedNow,
          });
        }

        if (terminal || cancelled || attempt >= MAX_RECONNECT_ATTEMPTS) {
          setState((s) => ({
            ...s,
            status: "closed",
            lastError: s.lastError ?? (text || null),
            sessionEnded: s.sessionEnded || sessionEndedNow,
          }));
          return;
        }

        // Schedule a retry with exponential backoff. Don't blow away
        // a friendlier server-supplied error message that the UI may
        // already be showing.
        attempt += 1;
        const delay = backoffDelay(attempt);
        setState((s) => ({
          ...s,
          status: "reconnecting",
          lastError: s.lastError ?? text ?? `网络波动，${Math.round(delay / 1000)} 秒后重连…`,
        }));
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };
    }

    // Seed transcripts from the REST hydrate so the page doesn't
    // flash empty between sessionId set and first WS event.
    setState({
      ...INITIAL,
      transcripts: initialTranscriptsRef.current,
      comments: initialCommentsRef.current,
    });
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHeartbeat();
      clearPartialIdleTimer();
      const ws = wsRef.current;
      if (ws) {
        // Use code 1000 (normal closure) so the server's host slot
        // frees up promptly rather than waiting for TCP timeout.
        try { ws.close(1000, "client_unmount"); } catch { /* noop */ }
        wsRef.current = null;
      }
    };
  }, [sessionId]);

  // Counters here just so we can see "frames left the page" in the
  // console without each frame turning into a log line. Logs sample
  // every 20th frame plus the first 3 (the failure mode "no audio at
  // all" shows up at the very start).
  const sendBinaryStatsRef = useRef({ sent: 0, dropped: 0 });
  const sendBinary = useCallback((buf: ArrayBuffer | Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendBinaryStatsRef.current.dropped += 1;
      if (sendBinaryStatsRef.current.dropped <= 3 || sendBinaryStatsRef.current.dropped % 20 === 0) {
        console.warn("[meeting] sendBinary dropped (ws not open)", {
          dropped: sendBinaryStatsRef.current.dropped,
          readyState: ws?.readyState,
        });
      }
      return;
    }
    try {
      ws.send(buf);
      sendBinaryStatsRef.current.sent += 1;
      const n = sendBinaryStatsRef.current.sent;
      if (import.meta.env.DEV && (n <= 3 || n % 20 === 0)) {
        const size = buf instanceof Blob ? buf.size : buf.byteLength;
        console.log("[meeting] sendBinary → server", { n, size });
      }
    } catch (err) {
      sendBinaryStatsRef.current.dropped += 1;
      console.warn("[meeting] ws.send threw", err);
    }
  }, []);

  const sendText = useCallback((event: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(event)); } catch { /* drop */ }
  }, []);

  const askAssistant = useCallback((question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    sendText({ type: "ask_assistant", question: trimmed });
  }, [sendText]);

  const commentNow = useCallback(() => {
    sendText({ type: "comment_now" });
  }, [sendText]);

  return { state, sendBinary, sendText, askAssistant, commentNow };
}
