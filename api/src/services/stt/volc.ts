import WebSocket from "ws";
import type { VolcSttCreds } from "../settings.js";
import { volcAuthHeaders } from "../volcAuth.js";
import type { SttProvider, SttSession, SttSessionOpts } from "./types.js";

// 火山引擎(豆包)流式语音识别 provider.
//
// credentials are resolved by the registry from DB (Setting
// row `volc.stt.creds`) > env (VOLC_STT_APP_ID + VOLC_STT_ACCESS_TOKEN)
// > null. The provider receives an already-resolved VolcSttCreds
// object — it doesn't read env directly anymore.
//
// Optional knobs (creds.endpoint / creds.resourceId):
//   default endpoint: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
//   default resourceId: volc.bigasr.sauc.duration
//
// Protocol summary (per 火山 公开文档,2026 vintage):
//   1. Open WSS with auth headers (see volcAuth.ts: `X-Api-Key` for the new
//      console, or `X-Api-App-Key` + `X-Api-Access-Key` for the old one),
//      plus `X-Api-Resource-Id`, `X-Api-Connect-Id`.
//   2. Send a binary "full-client-request" frame:
//        [4-byte header] + [JSON config payload as binary]
//      with header bits flagging "first packet, no compression,
//      JSON serialization, server returns JSON".
//   3. For each audio chunk:
//        [4-byte header] + [Opus/PCM bytes]
//      header bits = "audio frame, no flags / last-frame-flag".
//   4. Server replies with binary frames carrying JSON:
//        { result: { text: "..." }, ... is_final: bool }
//
// THIS FILE intentionally implements the protocol in a way that
// MATCHES the public 火山 streaming ASR shape, but the exact
// header bit layout and resource-id values vary across 火山
// product lines (bigmodel ASR vs legacy ASR vs sauc). If the
// caller wires in the wrong endpoint/resource-id, the server
// closes with code 4xxx. We log the close code + reason so an
// operator can match it to 火山's error table.
//
// If you find any field doesn't match your tenant's account
// (e.g. resource id), set the env vars above to override and
// adjust the buildHeader() helper as needed.

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
const DEFAULT_RESOURCE_ID = "volc.bigasr.sauc.duration";

// Spec: 4 bytes [version+header_size, message_type+flags,
//                serialization+compression, reserved]
function buildHeader(messageType: 1 | 2 | 4, flags: number, serialization = 0x10 /* JSON */, compression = 0x00 /* none */): Buffer {
  // First nibble = protocol version (1), second = header size in 4-byte units (1).
  const byte0 = (0x1 << 4) | 0x1;
  const byte1 = (messageType << 4) | (flags & 0x0F);
  const byte2 = (serialization & 0xF0) | (compression & 0x0F);
  const byte3 = 0x00;
  return Buffer.from([byte0, byte1, byte2, byte3]);
}

const MSG_FULL_CLIENT = 0x1;
const MSG_AUDIO       = 0x2;
const MSG_RESULT      = 0x9;     // expected from server
const MSG_ERROR       = 0xF;

const FLAG_NONE       = 0x0;
const FLAG_LAST_AUDIO = 0x2;

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// A client message on the wire = 4-byte header + 4-byte big-endian payload
// length + payload. The length field is MANDATORY: omitting it makes the
// server read the first 4 payload bytes as the size and reject the frame with
// "declared body size does not match actual body size" (verified live against
// openspeech /api/v3/sauc/bigmodel). Audio frames carry raw bytes
// (serialization "none"); the full-client config frame carries JSON (0x10).
export function clientFrame(messageType: 1 | 2 | 4, flags: number, payload: Buffer): Buffer {
  const serialization = messageType === MSG_AUDIO ? 0x00 : 0x10;
  return Buffer.concat([buildHeader(messageType, flags, serialization), be32(payload.length), payload]);
}

// Decode one server frame: 4-byte header + [4-byte sequence when flags&0x01]
// + 4-byte big-endian payload size + payload (JSON). The sequence field rides
// on non-final frames (flags 0x1/0x3); the last packet sets bit 0x02 (flags
// 0x2/0x3). Returns the raw JSON body string for the caller to parse.
export function decodeServerFrame(buf: Buffer): { messageType: number; flags: number; body: string } {
  const messageType = (buf[1] ?? 0) >> 4;
  const flags = (buf[1] ?? 0) & 0x0f;
  let off = 4;
  if (flags & 0x01) off += 4;
  let body = "";
  if (buf.length >= off + 4) {
    const size = buf.readUInt32BE(off);
    off += 4;
    body = buf.subarray(off, off + size).toString("utf8");
  }
  return { messageType, flags, body };
}

// ─── Streaming transcript de-dup ─────────────────────────────────
// 火山 sauc sends CUMULATIVE utterances: an already-finalized (definite)
// segment reappears in EVERY later frame while the next sentence streams. Naive
// per-frame emission re-fires onFinal for each definite segment on every frame
// → the transcript panel floods and a duplicate DB row is inserted each time.
// collectUtteranceEvents() de-dups finals by start_time and only surfaces the
// trailing partial when it changes. `state` is mutated across calls per session.
export interface SttStreamState {
  finalizedStarts: Set<number>;
  lastPartial: string;
}
export type SttEvent =
  | { kind: "final"; text: string; startMs: number; endMs: number }
  | { kind: "partial"; text: string; atMs: number };

export function collectUtteranceEvents(
  utterances: { text?: unknown; definite?: unknown; start_time?: unknown; end_time?: unknown }[],
  state: SttStreamState,
  nowMs: number,
): SttEvent[] {
  const events: SttEvent[] = [];
  let partialText = "";
  let partialEnd = nowMs;
  for (const u of utterances) {
    if (typeof u.text !== "string" || !u.text) continue;
    const startMs = typeof u.start_time === "number" ? u.start_time : Math.max(0, nowMs - 2_000);
    const endMs = typeof u.end_time === "number" ? u.end_time : nowMs;
    if (u.definite === true) {
      if (!state.finalizedStarts.has(startMs)) {
        state.finalizedStarts.add(startMs);
        state.lastPartial = "";          // segment done — reset the live line
        events.push({ kind: "final", text: u.text, startMs, endMs });
      }
    } else {
      partialText = u.text;              // last non-definite = current partial
      partialEnd = endMs;
    }
  }
  // Only surface the live partial when it actually changed (火山 streams a frame
  // per audio chunk, re-sending identical partials otherwise).
  if (partialText && partialText !== state.lastPartial) {
    state.lastPartial = partialText;
    events.push({ kind: "partial", text: partialText, atMs: partialEnd });
  }
  return events;
}

// Map a finalized segment onto the meeting wall clock. The trailing edge is the
// arrival time (nowRel, meeting-relative); the start is that minus the 火山
// utterance duration — but clamped to never precede the previous final's end
// (prevFinalEndMs). The summary view persists transcripts and sorts them by
// startMs asc (routes/meeting.ts), and 火山 can finalize a long utterance right
// after a short one, so without the clamp a long segment's back-derived start
// could land before an earlier row and reorder the saved transcript. Result:
// segments stay ordered and non-overlapping. nowRel is itself monotonic across
// arrivals (Date.now), so endMs is monotonic too.
// MIN_SEGMENT_MS: when several finals are emitted in the SAME ws message tick
// they share one nowRel, so the trailing edge can't advance via wall clock.
// Without a floor, every final after the first would get endMs===prevFinalEndMs
// and a back-derived startMs===endMs — a run of zero-width segments stacked at
// the same instant. We give each subsequent same-tick final a minimal positive
// width so segments stay ordered, non-overlapping, AND non-degenerate.
const MIN_SEGMENT_MS = 1;
export function nextFinalSegment(
  nowRel: number,
  durMs: number,
  prevFinalEndMs: number,
): { startMs: number; endMs: number } {
  // Floor the trailing edge to prevFinalEndMs + MIN_SEGMENT_MS so a same-tick
  // batch advances by at least 1ms per final instead of collapsing onto the
  // previous final's end. nowRel still wins when the clock has moved on, so
  // this never rewinds time — endMs stays monotonic.
  const endMs = Math.max(nowRel, prevFinalEndMs + MIN_SEGMENT_MS);
  const startMs = Math.min(endMs, Math.max(prevFinalEndMs, endMs - Math.max(0, durMs)));
  return { startMs, endMs };
}

interface ResolvedVolcConfig {
  apiKey?: string;
  appId?: string;
  accessToken?: string;
  endpoint: string;
  resourceId: string;
  /** 火山 hotword table id; sent as request.corpus.boosting_table_id. */
  boostingTableId?: string;
  /** 识别模型名(request.model_name)。默认 bigmodel。 */
  model?: string;
}

// 会议内联热词：默认不带任何词，可用 env VOLC_STT_HOTWORDS 配置(逗号/顿号/空格分隔)，让 STT 把
// 同音/近音词(如同事人名)纠到正确写法；设为空串或 "off" 表示关闭(回退到纯模型识别 + 可选的控制台热词表)。
const DEFAULT_MEETING_HOTWORDS: string[] = [];

// Resolve the inline hotword list. Exported (+ takes an explicit `raw`) so the
// env parsing is unit-testable. undefined env → 默认空列表; ""/"off"
// → disabled (empty); otherwise split on comma/、/whitespace.
export function resolveMeetingHotwords(raw = process.env.VOLC_STT_HOTWORDS): string[] {
  if (raw === undefined) return DEFAULT_MEETING_HOTWORDS;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "off") return [];
  return trimmed.split(/[,，、\s]+/).map((w) => w.trim()).filter(Boolean);
}

// Build the JSON "full-client-request" config payload sent as the first frame.
// Extracted (and exported) so the hotword wiring is unit-testable without a
// live WS. Frontend captures raw 16 kHz s16le mono PCM (Web Audio); 火山 sauc
// accepts pcm directly and REJECTS webm/opus.
export function buildSttRequestConfig(opts: { sessionId: string; boostingTableId?: string; model?: string; hotwords?: string[] }): string {
  // 热词偏置有两条并存的路子,都挂在 request.corpus 下:
  //   1) boosting_table_id —— 控制台「自学习平台→热词管理」建好的热词表 id(适合大词表 /
  //      跨会复用)。
  //   2) context.hotwords —— 内联词表(形如 [{word}],context_type=dialog_ctx),把固定的一
  //      小撮人名/术语直接随请求下发,无需建表。见 volcengine-audio SDK 的 ASR V3 结构。
  // 两者可同时给。都没有时不发 corpus。
  const corpus: Record<string, unknown> = {};
  if (opts.boostingTableId) corpus.boosting_table_id = opts.boostingTableId;
  if (opts.hotwords && opts.hotwords.length > 0) {
    corpus.context = { hotwords: opts.hotwords.map((w) => ({ word: w })), context_type: "dialog_ctx" };
  }
  return JSON.stringify({
    user: { uid: opts.sessionId },
    audio: {
      format: "pcm",
      codec: "raw",
      rate: 16_000,
      bits: 16,
      channel: 1,
    },
    request: {
      // 识别模型。默认 bigmodel(精度高但吞吐可能 < 实时,长会议会累积延迟)。
      // 可在 /admin/settings 改为更快的模型 / 配合 endpoint+resourceId 切到
      // 低延迟流式 ASR,让处理速度稳定 ≥ 1× 实时。见 docs / VolcSttCreds.model。
      model_name: opts.model || "bigmodel",
      enable_itn: true,         // inverse text normalization (numbers etc)
      enable_punc: true,        // automatic punctuation
      show_utterances: true,    // partial + final segments
      enable_speaker_info: false,
      ...(Object.keys(corpus).length > 0 ? { corpus } : {}),
    },
  });
}

export class VolcSttProvider implements SttProvider {
  readonly name = "volc" as const;
  private readonly cfg: ResolvedVolcConfig;

  constructor(creds: VolcSttCreds) {
    if (!creds.apiKey && (!creds.appId || !creds.accessToken)) {
      throw new Error("VolcSttProvider constructed without apiKey or appId + accessToken");
    }
    this.cfg = {
      apiKey: creds.apiKey,
      appId: creds.appId,
      accessToken: creds.accessToken,
      endpoint: creds.endpoint || DEFAULT_ENDPOINT,
      resourceId: creds.resourceId || DEFAULT_RESOURCE_ID,
      boostingTableId: creds.boostingTableId,
      model: creds.model,
    };
  }

  open(opts: SttSessionOpts): SttSession {
    const cfg = this.cfg;
    const ws = new WebSocket(cfg.endpoint, {
      headers: {
        ...volcAuthHeaders(cfg, cfg.resourceId),
        "X-Api-Connect-Id": opts.sessionId,
      },
    });

    let opened = false;
    // `closed` flips true on EITHER caller-initiated close() OR
    // server-initiated `ws.on("close")` fire. Both paths must set
    // it — without the server-side branch, pushChunk would keep
    // calling ws.send() on a dead socket forever, throwing +
    // swallowing exceptions at ~2 Hz. The error toast also only
    // fires once.
    let closed = false;
    // Resolved when the WS truly terminates. close() returns this
    // promise so shutdown paths actually wait for the server's
    // trailing final to arrive before tearing down the session.
    let resolveClosePromise: (() => void) | null = null;
    const closePromise = new Promise<void>((resolve) => { resolveClosePromise = resolve; });
    // Hard cap how long we'll wait for the server's trailing
    // response after close. 3 s is generous for normal RTT; beyond
    // that the meeting end shouldn't be blocked any further.
    const CLOSE_WAIT_TIMEOUT_MS = 3_000;
    const pendingBeforeOpen: Buffer[] = [];
    // Per-session de-dup state for collectUtteranceEvents (see below).
    const streamState: SttStreamState = { finalizedStarts: new Set<number>(), lastPartial: "" };
    // TIMESTAMPS — wall-clock-at-arrival.
    // 火山 reports utterance start_time/end_time relative to this session's first
    // audio (火山 SESSION time). We do NOT map those onto the meeting timeline via
    // a fixed base anymore: the previous scheme broke the moment audio stopped
    // tracking wall time 1:1 (client VAD dropping silence, server shedding audio
    // to catch up, or 火山 running behind real time). Instead we stamp every
    // emitted transcript with the MEETING-RELATIVE WALL CLOCK at the instant the
    // result arrives (Date.now() - meetingStartedAtMs), preserving the 火山
    // utterance DURATION for the segment's start. This is robust to silence
    // dropping, audio shedding, session stop/restart (火山 clock resets to 0),
    // and backlog — and the UI only renders hh:mm, so sub-second placement of the
    // trailing edge is irrelevant.
    //
    // LAG — recognition backlog, measured in 火山 SESSION time:
    //   fedMs       = audio bytes we've pushed / 32 (16kHz·16bit mono = 32 B/ms)
    //   sessionMaxMs = max 火山 utterance end_time seen = audio 火山 has recognized
    //   lagMs       = fedMs - sessionMaxMs  (un-recognized audio sitting in 火山)
    // The meeting layer reads lagMs() to shed audio before the transcript runs
    // tens/hundreds of seconds behind. Both terms count only audio actually sent
    // to 火山, so client-side VAD doesn't skew the measure.
    let sessionMaxMs = 0;
    let fedBytes = 0;
    // True once 火山 has sent at least one utterance carrying an end_time. lagMs()
    // stays 0 until then so the flat `result.text` response shape (which never
    // advances sessionMaxMs) can't make lag climb unbounded and trip the
    // server's catch-up gate into a permanent shed.
    let sawUtterance = false;
    // Monotonic floor for emitted final timestamps. 火山 finalizes a long
    // utterance only when it ends, so a long segment can finalize right after a
    // short one; anchoring each final's trailing edge to wall-clock-at-arrival
    // and then subtracting its 火山 duration could place its start BEFORE the
    // previous final's start. The summary view persists + sorts by startMs asc
    // (routes/meeting.ts), so that would reorder saved rows. Clamp every final to
    // start no earlier than the previous final's end — keeping segments ordered
    // and non-overlapping.
    let prevFinalEndMs = 0;
    // Set by the caller's close(); distinguishes an intentional shutdown from
    // an UNEXPECTED upstream death so onClosed (→ reopen) only fires for the latter.
    let clientInitiatedClose = false;
    let deadReported = false;
    // Single terminal transition. BOTH the server WS close AND a fatal 火山
    // error frame ("session has ended") route here so the two can't drift: stop
    // pushChunk, drain the queue, resolve close() waiters. Fires onClosed ONLY
    // for an unexpected death so the meeting layer reopens a fresh session
    // instead of swallowing audio into a corpse (the 346-error-flood bug).
    const markDead = (reason: string): void => {
      const wasAlive = !closed;
      closed = true;
      opened = false;
      pendingBeforeOpen.length = 0;
      try { ws.close(); } catch { /* noop */ }
      resolveClosePromise?.();
      if (wasAlive && !clientInitiatedClose && !deadReported) {
        deadReported = true;
        opts.onClosed?.(reason);
      }
    };
    // PROTOCOL NOTE: the 4-byte header bit layout in buildHeader()
    // is based on PUBLIC documentation and HAS NOT been smoke-tested
    // against a live 火山 endpoint. Before flipping production over
    // to volc, write a one-shot script that connects + sends a short
    // WAV clip + prints the response to verify endpoint, resource_id,
    // and header bits match your tenant's account.

    ws.on("open", () => {
      if (closed) return;
      opened = true;
      // Send the initial JSON config frame. Schema (incl. optional hotword corpus
      // + model_name) lives in buildSttRequestConfig() so it's unit-tested.
      // Inline hotwords (同事人名) ride along by default; env VOLC_STT_HOTWORDS overrides/disables.
      const config = buildSttRequestConfig({ sessionId: opts.sessionId, boostingTableId: cfg.boostingTableId, model: cfg.model, hotwords: resolveMeetingHotwords() });
      const payload = clientFrame(MSG_FULL_CLIENT, FLAG_NONE, Buffer.from(config, "utf8"));
      try { ws.send(payload); } catch { /* close handler will surface */ }
      // Flush anything that arrived before open.
      for (const chunk of pendingBeforeOpen) {
        try { ws.send(clientFrame(MSG_AUDIO, FLAG_NONE, chunk)); } catch { /* noop */ }
      }
      pendingBeforeOpen.length = 0;
    });

    ws.on("message", (data) => {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const { messageType, flags, body } = decodeServerFrame(buf);
        if (messageType === MSG_ERROR) {
          opts.onError(`volc stt error: ${body.slice(0, 200)}`);
          // 火山 keeps the WS OPEN after a fatal "session has ended" timeout and
          // error-replies to every further audio packet → 346-frame flood. Treat
          // that signature as terminal so we stop sending + the meeting reopens.
          // Other error bodies stay non-fatal (surface + keep streaming) until
          // we've seen their taxonomy in logs.
          if (/session has ended|waiting next packet/i.test(body)) {
            markDead("server error: session ended");
          }
          return;
        }
        if (messageType !== MSG_RESULT) return; // housekeeping frames: ignore
        let parsed: {
          result?: {
            text?: unknown;
            utterances?: { text?: unknown; definite?: unknown; start_time?: unknown; end_time?: unknown }[];
          };
        };
        try { parsed = JSON.parse(body) as typeof parsed; } catch { return; }
        // Meeting-relative wall clock at the instant this result arrives — the
        // anchor for every emitted timestamp (see the TIMESTAMPS note above).
        const nowRel = Math.max(0, Date.now() - opts.meetingStartedAtMs);
        // Finality comes from the protocol, NOT a JSON `is_final` field (sauc
        // doesn't send one): each finalized utterance carries definite:true,
        // and the stream's last packet sets the 0x02 header flag.
        const isLastPacket = (flags & 0x02) !== 0;
        const utterances = Array.isArray(parsed.result?.utterances) ? parsed.result.utterances : [];
        if (utterances.length > 0) {
          // Advance the lag gauge: how far 火山's recognition has reached, in 火山
          // SESSION time (max utterance end_time). Used by lagMs() below.
          for (const u of utterances) {
            const e = typeof u.end_time === "number" ? u.end_time : 0;
            if (e > sessionMaxMs) sessionMaxMs = e;
          }
          sawUtterance = true;
          // collectUtteranceEvents still works in 火山 SESSION time (its `nowMs`
          // fallback for missing start/end_time stays in that domain — we pass
          // sessionMaxMs so a timestamp-less utterance gets a ~2s default span).
          // We remap each emitted event onto the wall clock: the trailing edge =
          // nowRel; a final's start = nowRel minus its 火山 duration, clamped to
          // never precede the previous final (keeps persisted rows ordered).
          for (const ev of collectUtteranceEvents(utterances, streamState, sessionMaxMs)) {
            if (ev.kind === "final") {
              const seg = nextFinalSegment(nowRel, ev.endMs - ev.startMs, prevFinalEndMs);
              prevFinalEndMs = seg.endMs;
              opts.onFinal(ev.text, seg.startMs, seg.endMs);
            } else {
              opts.onPartial(ev.text, nowRel);
            }
          }
          return;
        }
        const text = typeof parsed.result?.text === "string" ? parsed.result.text : "";
        if (!text) return;
        if (isLastPacket) {
          const seg = nextFinalSegment(nowRel, 2_000, prevFinalEndMs);
          prevFinalEndMs = seg.endMs;
          opts.onFinal(text, seg.startMs, seg.endMs);
        } else {
          opts.onPartial(text, nowRel);
        }
      } catch (err) {
        opts.onError(`volc stt parse failed: ${(err as Error).message}`);
      }
    });

    ws.on("error", (err) => {
      // `error` is typically followed immediately by `close`; this
      // just surfaces the readable reason. The `close` handler
      // below does the actual state cleanup.
      // 主动关闭(如握手完成前主持人就结束)触发的 error 不是上游故障,不上报,
      // 否则会被熔断器计为失败。
      if (clientInitiatedClose) return;
      opts.onError(`volc stt ws error: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      if (!closed && !clientInitiatedClose) {
        // Surface the close info — common values are 4xxx for auth
        // / quota errors; 1011 for server overload.
        opts.onError(`volc stt closed: code=${code} reason=${reason.toString().slice(0, 200)}`);
      }
      // markDead does the state teardown (closed/opened/queue/closePromise) and
      // fires onClosed when this was an unexpected server-side close.
      markDead(`ws closed code=${code}`);
    });

    return {
      pushChunk(chunk: Buffer): void {
        if (closed) return;
        // Count every byte we hand to 火山 (pre-open chunks flush on open) so
        // lagMs() can compare audio-fed against audio-recognized.
        fedBytes += chunk.length;
        if (!opened) { pendingBeforeOpen.push(chunk); return; }
        try {
          ws.send(clientFrame(MSG_AUDIO, FLAG_NONE, chunk));
        } catch { /* close handler will surface */ }
      },
      // Bytes still queued in the 火山 WS send buffer. Growing = we're
      // producing audio faster than the upstream link accepts it.
      bufferedBytes: () => ws.bufferedAmount,
      // Recognition backlog in ms: audio fed (fedBytes / 32 B-per-ms) minus the
      // audio 火山 has recognized (sessionMaxMs). 16kHz·16bit·mono = 32 B/ms.
      // Returns 0 until we've seen a real utterance end_time, so the flat
      // result.text response shape (no end_time → sessionMaxMs frozen at 0) can't
      // report runaway lag and wedge the catch-up gate permanently open. The
      // /32 constant assumes the negotiated 16kHz·16bit·mono format.
      lagMs: () => (sawUtterance ? Math.max(0, fedBytes / 32 - sessionMaxMs) : 0),
      async close(): Promise<void> {
        if (closed) {
          // Already closed (server-initiated or earlier client
          // close). The promise from the previous call already
          // resolved — no work, just await the resolved promise
          // for the same shape.
          await closePromise;
          return;
        }
        // Mark BEFORE we close the socket so the resulting ws.on("close") →
        // markDead does NOT fire onClosed (this is an intentional shutdown, not
        // an upstream death — the caller must not auto-reopen).
        clientInitiatedClose = true;
        // Send the LAST_AUDIO sentinel so the server flushes any
        // trailing transcript result before it closes the channel.
        if (opened) {
          // Empty last-audio frame: header + 4-byte length(0). The server
          // flushes any trailing transcript, then closes.
          try { ws.send(clientFrame(MSG_AUDIO, FLAG_LAST_AUDIO, Buffer.alloc(0))); } catch { /* noop */ }
        }
        try { ws.close(1000, "client_close"); } catch { /* noop */ }
        // Race the actual close against a hard timeout so a
        // misbehaving server can't block meeting shutdown.
        await Promise.race([
          closePromise,
          new Promise<void>((res) => setTimeout(res, CLOSE_WAIT_TIMEOUT_MS)),
        ]);
      },
    };
  }
}
