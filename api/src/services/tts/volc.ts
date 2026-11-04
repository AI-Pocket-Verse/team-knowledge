import WebSocket from "ws";
import { mkdir, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../../env.js";
import type { VolcTtsCreds } from "../settings.js";
import { volcAuthHeaders } from "../volcAuth.js";
import type { TtsProvider, TtsSynthesisRequest } from "./types.js";

// 火山引擎(豆包)双向流式语音合成 — V3 protocol.
//
// Why V3 (and not V1):
//   V1 (/api/v1/tts/ws_binary) is the legacy "BV001_streaming /
//   cluster=volcano_tts" path. The current 控制台 only opens
//   "TTS 大模型 / 语音合成 2.0" which is V3-only — V1 keys return
//   403 on those accounts. V3 uses:
//     - endpoint: /api/v3/tts/bidirection
//     - resourceId: volc.service_type.10029 (fixed)
//     - 事件驱动 frame format with explicit StartConnection /
//       StartSession / TaskRequest / FinishSession lifecycle
//     - "bigtts" 系列音色 (e.g. zh_female_qingxin_v2_mars_bigtts)
//
// File-based delivery preserved: this provider opens its own WS,
// drives the lifecycle to completion, writes the resulting mp3
// stream into data/meeting-tts/<commentId>.mp3, and returns the
// URL. The caller (speaker.ts) sees the same {audioUrl|null}
// interface — no changes to the meeting-WS layer.
//
// PROTOCOL CAVEAT: event ids + frame layout pieced together from
// public docs + community implementations. The basic lifecycle
// (Connect→Session→Task→Finish) is well-documented; the exact
// numeric event ids for SERVER-SIDE replies (50 / 150 / 152 / 51)
// are inferred. If a tenant returns an unknown event id we just
// log it as a warning and keep accumulating audio — the implicit
// "session finished" signal we rely on is the WS close.

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
const DEFAULT_RESOURCE_ID = "volc.service_type.10029";
// Default bigtts voice. NOTE: voice availability is ACCOUNT-SPECIFIC — a voice
// the account hasn't activated returns {"error":"resource ID is mismatched with
// speaker related resource"}. This default is verified working against the
// live endpoint; admin can override per-account via the /admin/settings TTS
// "Voice" field (音色列表 in 火山控制台 → 语音合成).
const DEFAULT_VOICE = "zh_female_wanwanxiaohe_moon_bigtts";
const HARD_TIMEOUT_MS = 30_000;
// Cap on the WriteStream's in-memory backlog (writableLength) before we start
// dropping incoming audio chunks. A single TTS clip is a few hundred KB of mp3
// at most; 8 MiB is far past a healthy clip yet bounds memory if the disk
// stalls. Past this we drop chunks rather than buffer unbounded (→ OOM).
const MAX_TTS_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

// ─── Binary message types ───────────────────────
const MSG_FULL_CLIENT = 0x1;
const MSG_FULL_SERVER = 0x9;
const MSG_AUDIO_SERVER = 0xB;
const MSG_ERROR = 0xF;

// ─── Flag bits (header byte 1 low nibble) ─────
// Bit 0x4 = "this frame carries an event_id + session_id prefix
// before the payload". V3 sets this on every event frame.
const FLAG_EVENT_PAYLOAD = 0x4;

// ─── Event IDs ───────────────────────────────
// Client → server
const EVENT_START_CONNECTION = 1;
const EVENT_FINISH_CONNECTION = 2;
const EVENT_START_SESSION = 100;
const EVENT_FINISH_SESSION = 102;
const EVENT_TASK_REQUEST = 200;
// Server → client (inferred from community implementations)
const EVENT_CONNECTION_STARTED = 50;
const EVENT_CONNECTION_FAILED = 51;
const EVENT_CONNECTION_FINISHED = 52;
const EVENT_SESSION_STARTED = 150;
const EVENT_SESSION_FINISHED = 152;
const EVENT_SESSION_FAILED = 153;
const EVENT_TTS_SENTENCE_START = 350;
const EVENT_TTS_SENTENCE_END = 351;
const EVENT_TTS_RESPONSE = 352;

function buildHeader(messageType: number, flags: number): Buffer {
  const byte0 = (0x1 << 4) | 0x1;                          // protocol v1 | header size 1
  const byte1 = ((messageType & 0xF) << 4) | (flags & 0xF);
  const byte2 = (0x1 << 4) | 0x0;                          // JSON serialization | no compression
  return Buffer.from([byte0, byte1, byte2, 0x00]);
}

function be32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

// Connection-level events (StartConnection / FinishConnection) —
// no session id, payload directly after event id length+bytes.
function buildConnectionFrame(eventId: number, payload: string): Buffer {
  const header = buildHeader(MSG_FULL_CLIENT, FLAG_EVENT_PAYLOAD);
  const payloadBytes = Buffer.from(payload, "utf8");
  return Buffer.concat([header, be32(eventId), be32(payloadBytes.length), payloadBytes]);
}

// Session-level events (StartSession / TaskRequest / FinishSession) —
// include a session_id between event_id and payload.
function buildSessionFrame(eventId: number, sessionId: string, payload: string): Buffer {
  const header = buildHeader(MSG_FULL_CLIENT, FLAG_EVENT_PAYLOAD);
  const sessionBytes = Buffer.from(sessionId, "utf8");
  const payloadBytes = Buffer.from(payload, "utf8");
  return Buffer.concat([
    header,
    be32(eventId),
    be32(sessionBytes.length), sessionBytes,
    be32(payloadBytes.length), payloadBytes,
  ]);
}

interface ParsedFrame {
  messageType: number;
  flags: number;
  eventId?: number;
  sessionId?: string;
  payload: Buffer;
}

export function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 4) return null;
  const messageType = (buf[1]! >> 4) & 0xF;
  const flags = buf[1]! & 0xF;
  let offset = 4;
  let eventId: number | undefined;
  let sessionId: string | undefined;
  if (flags & FLAG_EVENT_PAYLOAD) {
    if (buf.length < offset + 4) return null;
    eventId = buf.readUInt32BE(offset);
    offset += 4;
    // Server event frames carry an id string (length+bytes) before the
    // payload:
    //   • session-level events (>=100): the session_id
    //   • connection-level RESPONSES (50/51/52): the connection_id
    // (The StartConnection/FinishConnection events WE send have no id, but
    // those are outbound and never parsed here.) Missing the connection_id
    // on 50/51/52 made offset land mid-frame → the session stalled and
    // synthesis timed out. Verified live against /api/v3/tts/bidirection.
    const carriesIdString =
      eventId >= EVENT_START_SESSION ||
      (eventId >= EVENT_CONNECTION_STARTED && eventId <= EVENT_CONNECTION_FINISHED);
    if (carriesIdString) {
      if (buf.length < offset + 4) return null;
      const idLen = buf.readUInt32BE(offset);
      offset += 4;
      if (buf.length < offset + idLen) return null;
      sessionId = buf.subarray(offset, offset + idLen).toString("utf8");
      offset += idLen;
    }
  }
  if (buf.length < offset + 4) return null;
  const payloadLen = buf.readUInt32BE(offset);
  offset += 4;
  if (buf.length < offset + payloadLen) return null;
  return { messageType, flags, eventId, sessionId, payload: buf.subarray(offset, offset + payloadLen) };
}

export class VolcTtsProvider implements TtsProvider {
  readonly name = "volc" as const;
  private readonly cfg: {
    apiKey?: string;
    appId?: string;
    accessToken?: string;
    endpoint: string;
    voice: string;
    resourceId: string;
  };

  constructor(creds: VolcTtsCreds) {
    if (!creds.apiKey && (!creds.appId || !creds.accessToken)) {
      throw new Error("VolcTtsProvider constructed without apiKey or appId + accessToken");
    }
    this.cfg = {
      apiKey: creds.apiKey,
      appId: creds.appId,
      accessToken: creds.accessToken,
      endpoint: creds.endpoint || DEFAULT_ENDPOINT,
      voice: creds.voice || DEFAULT_VOICE,
      resourceId: env.VOLC_TTS_RESOURCE_ID || DEFAULT_RESOURCE_ID,  // 新版控制台的音色可能要用 seed-tts-2.0 等，见 README
    };
  }

  async synthesize(req: TtsSynthesisRequest): Promise<{ audioUrl: string | null }> {
    if (!req.text.trim()) return { audioUrl: null };
    const dir = resolve(join(env.DATA_DIR, "meeting-tts"));
    await mkdir(dir, { recursive: true });
    // Streamed comments synthesize one clip per sentence → `<commentId>-<seq>.mp3`;
    // the legacy whole-comment path keeps `<commentId>.mp3`.
    const filename = req.seq != null ? `${req.commentId}-${req.seq}.mp3` : `${req.commentId}.mp3`;
    const filePath = join(dir, filename);
    try {
      await this.synthesizeToFile(req, filePath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[volc-tts/v3] synthesize failed (sessionId=${req.sessionId} commentId=${req.commentId}):`,
        (err as Error).message,
      );
      // Clean up any partial mp3 so the auth-gated /meeting-tts
      // route can't later serve a half-written file.
      try { await unlink(filePath); } catch { /* may not exist */ }
      return { audioUrl: null };
    }
    return { audioUrl: `/meeting-tts/${filename}` };
  }

  private synthesizeToFile(req: TtsSynthesisRequest, filePath: string): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      // Per-synthesis session id. The HTTP X-Api-Connect-Id header
      // gets the same value so server-side logs correlate.
      const sessionId = randomUUID();
      const ws = new WebSocket(this.cfg.endpoint, {
        headers: {
          ...volcAuthHeaders(this.cfg, this.cfg.resourceId),
          "X-Api-Connect-Id": sessionId,
        },
      });

      const out = createWriteStream(filePath);
      let settled = false;
      let audioReceived = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        try { ws.close(); } catch { /* noop */ }
        out.end(() => {
          // If we got at least some audio before the error, treat
          // it as success (truncated playback is better than total
          // silence). Real failures (no audio + error) reject.
          if (err && !audioReceived) rejectP(err);
          else resolveP();
        });
      };
      const guard = setTimeout(() => finish(new Error("volc tts timeout")), HARD_TIMEOUT_MS);

      ws.on("open", () => {
        // Step 1: kick the lifecycle with StartConnection.
        try {
          ws.send(buildConnectionFrame(EVENT_START_CONNECTION, "{}"));
        } catch (err) {
          finish(err as Error);
        }
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const frame = parseFrame(buf);
          if (!frame) return;

          // ─── error frame ───
          if (frame.messageType === MSG_ERROR) {
            finish(new Error(`volc tts error frame: ${frame.payload.toString("utf8").slice(0, 300)}`));
            return;
          }

          // ─── audio chunk ───
          if (frame.messageType === MSG_AUDIO_SERVER) {
            if (frame.payload.length > 0) {
              // Backpressure guard: out.write() returning false means the OS
              // write buffer is full (slow disk). We don't pause the WS (volc
              // streams faster than a stalled disk and there's no upstream
              // flow-control here), but we DO cap the in-memory buffer so a
              // slow disk can't grow it unbounded. Past the cap we drop the
              // chunk — a slightly truncated clip (audioReceived already true)
              // is better than OOM. Under normal disk speed write() returns
              // true and nothing is dropped.
              if (out.writableLength <= MAX_TTS_WRITE_BUFFER_BYTES) {
                out.write(frame.payload);
                audioReceived = true;
              }
            }
            return;
          }

          // ─── JSON control frame ───
          if (frame.messageType === MSG_FULL_SERVER) {
            switch (frame.eventId) {
              case EVENT_CONNECTION_STARTED: {
                // Step 2: open the synthesis session.
                const startPayload = JSON.stringify({
                  event: EVENT_START_SESSION,
                  namespace: "BidirectionalTTS",
                  user: { uid: req.sessionId },
                  req_params: {
                    speaker: req.voice ?? this.cfg.voice,
                    audio_params: { format: "mp3", sample_rate: 24000 },
                  },
                });
                ws.send(buildSessionFrame(EVENT_START_SESSION, sessionId, startPayload));
                return;
              }
              case EVENT_SESSION_STARTED: {
                // Step 3: send the full text in one TaskRequest,
                // then immediately FinishSession so the server
                // doesn't wait the 4s "more text might come"
                // timeout before finalizing.
                const taskPayload = JSON.stringify({
                  event: EVENT_TASK_REQUEST,
                  namespace: "BidirectionalTTS",
                  user: { uid: req.sessionId },
                  req_params: { text: req.text },
                });
                ws.send(buildSessionFrame(EVENT_TASK_REQUEST, sessionId, taskPayload));
                const finishPayload = JSON.stringify({
                  event: EVENT_FINISH_SESSION,
                  namespace: "BidirectionalTTS",
                  user: { uid: req.sessionId },
                });
                ws.send(buildSessionFrame(EVENT_FINISH_SESSION, sessionId, finishPayload));
                return;
              }
              case EVENT_SESSION_FINISHED: {
                // Step 4: close the WS gracefully.
                try { ws.send(buildConnectionFrame(EVENT_FINISH_CONNECTION, "{}")); } catch { /* noop */ }
                return;
              }
              case EVENT_CONNECTION_FINISHED: {
                finish();
                return;
              }
              case EVENT_TTS_SENTENCE_START:
              case EVENT_TTS_SENTENCE_END:
              case EVENT_TTS_RESPONSE:
                // Marker / metadata events — no action needed.
                return;
              case EVENT_CONNECTION_FAILED:
              case EVENT_SESSION_FAILED: {
                finish(new Error(`volc tts ${frame.eventId === EVENT_CONNECTION_FAILED ? "connection" : "session"} failed: ${frame.payload.toString("utf8").slice(0, 300)}`));
                return;
              }
              default:
                // Unknown event — log but keep going. If audio is
                // arriving in parallel we'd rather collect it than
                // bail on an unexpected control frame.
                // eslint-disable-next-line no-console
                console.warn(`[volc-tts/v3] unknown server event id=${frame.eventId} payload=${frame.payload.toString("utf8").slice(0, 200)}`);
                return;
            }
          }
        } catch (err) {
          finish(err as Error);
        }
      });

      ws.on("error", (err) => finish(err));
      ws.on("close", (code, reason) => {
        if (settled) return;
        if (code === 1000) finish();
        else finish(new Error(`volc tts ws closed: code=${code} reason=${reason.toString().slice(0, 200)}`));
      });
    });
  }
}
