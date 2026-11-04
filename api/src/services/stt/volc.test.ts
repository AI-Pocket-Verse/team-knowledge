import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VolcSttProvider, clientFrame, decodeServerFrame, collectUtteranceEvents, buildSttRequestConfig, resolveMeetingHotwords, nextFinalSegment, type SttStreamState } from "./volc.js";

// Hotword (热词) wiring: a configured boosting_table_id must ride in
// request.corpus so 火山 biases domain vocabulary (a domain term) over homophones. With no table configured, corpus must be omitted entirely.
describe("buildSttRequestConfig (hotwords)", () => {
  it("includes request.corpus.boosting_table_id when a table id is set", () => {
    const cfg = JSON.parse(buildSttRequestConfig({ sessionId: "s1", boostingTableId: "tbl-9" }));
    expect(cfg.request.corpus).toEqual({ boosting_table_id: "tbl-9" });
    expect(cfg.user.uid).toBe("s1");
    expect(cfg.audio.format).toBe("pcm");
  });

  it("omits corpus entirely when no hotword table is configured", () => {
    const cfg = JSON.parse(buildSttRequestConfig({ sessionId: "s1" }));
    expect(cfg.request.corpus).toBeUndefined();
  });

  it("defaults model_name to bigmodel, and overrides it when model is set", () => {
    expect(JSON.parse(buildSttRequestConfig({ sessionId: "s1" })).request.model_name).toBe("bigmodel");
    expect(JSON.parse(buildSttRequestConfig({ sessionId: "s1", model: "smallmodel" })).request.model_name).toBe("smallmodel");
  });
});

// Inline hotwords (内联热词): a fixed list of names rides in request.corpus.context
// (hotwords:[{word}], context_type:dialog_ctx) so STT biases proper nouns without a
// console boosting table. Mirrors the volcengine-audio SDK's ASR V3 structure.
describe("buildSttRequestConfig (inline hotwords)", () => {
  it("puts the hotword list under corpus.context as [{word}] with context_type", () => {
    const cfg = JSON.parse(buildSttRequestConfig({ sessionId: "s1", hotwords: ["张三", "李四"] }));
    expect(cfg.request.corpus).toEqual({
      context: { hotwords: [{ word: "张三" }, { word: "李四" }], context_type: "dialog_ctx" },
    });
  });

  it("carries BOTH a boosting table id and inline hotwords when both are set", () => {
    const cfg = JSON.parse(buildSttRequestConfig({ sessionId: "s1", boostingTableId: "tbl-9", hotwords: ["王五"] }));
    expect(cfg.request.corpus.boosting_table_id).toBe("tbl-9");
    expect(cfg.request.corpus.context.hotwords).toEqual([{ word: "王五" }]);
  });

  it("omits corpus when hotwords is empty and no table is set", () => {
    expect(JSON.parse(buildSttRequestConfig({ sessionId: "s1", hotwords: [] })).request.corpus).toBeUndefined();
  });
});

describe("resolveMeetingHotwords (env override)", () => {
  it("env 未设置时默认不带任何内联热词", () => {
    expect(resolveMeetingHotwords(undefined)).toEqual([]);
  });

  it("disables inline hotwords on empty or 'off'", () => {
    expect(resolveMeetingHotwords("")).toEqual([]);
    expect(resolveMeetingHotwords("  ")).toEqual([]);
    expect(resolveMeetingHotwords("off")).toEqual([]);
  });

  it("splits an override on comma / 顿号 / whitespace and trims", () => {
    expect(resolveMeetingHotwords("张三, 李四、王五  赵六")).toEqual(["张三", "李四", "王五", "赵六"]);
  });
});

// Regression for the transcript flood: 火山 re-sends already-finalized
// (definite) utterances in every later frame (cumulative). Each definite
// segment must be finalized exactly once, and identical partials suppressed.
describe("collectUtteranceEvents (de-dup)", () => {
  const u = (text: string, definite: boolean, start: number, end: number) =>
    ({ text, definite, start_time: start, end_time: end });

  it("finalizes each definite segment exactly once across cumulative frames", () => {
    const state: SttStreamState = { finalizedStarts: new Set(), lastPartial: "" };
    // Frame 1: sentence A still in progress.
    expect(collectUtteranceEvents([u("你好", false, 0, 500)], state, 600))
      .toEqual([{ kind: "partial", text: "你好", atMs: 500 }]);
    // Frame 2: A finalized.
    expect(collectUtteranceEvents([u("你好。", true, 0, 700)], state, 800))
      .toEqual([{ kind: "final", text: "你好。", startMs: 0, endMs: 700 }]);
    // Frames 3-4: A STILL present (cumulative) while B streams → A must NOT
    // re-finalize; only B's partial surfaces.
    expect(collectUtteranceEvents([u("你好。", true, 0, 700), u("今天", false, 900, 1200)], state, 1300))
      .toEqual([{ kind: "partial", text: "今天", atMs: 1200 }]);
    expect(collectUtteranceEvents([u("你好。", true, 0, 700), u("今天天气", false, 900, 1500)], state, 1600))
      .toEqual([{ kind: "partial", text: "今天天气", atMs: 1500 }]);
    // Frame 5: B finalized — emitted once, A still suppressed.
    expect(collectUtteranceEvents([u("你好。", true, 0, 700), u("今天天气。", true, 900, 1700)], state, 1800))
      .toEqual([{ kind: "final", text: "今天天气。", startMs: 900, endMs: 1700 }]);
  });

  it("suppresses repeated identical partials", () => {
    const state: SttStreamState = { finalizedStarts: new Set(), lastPartial: "" };
    expect(collectUtteranceEvents([u("hello", false, 0, 300)], state, 400)).toHaveLength(1);
    // Same partial re-sent on the next frame → no event.
    expect(collectUtteranceEvents([u("hello", false, 0, 300)], state, 450)).toEqual([]);
  });
});

// Regression for the live-verified bug: client frames were sent WITHOUT the
// 4-byte payload-length prefix, so 火山 sauc/bigmodel rejected them with
// "declared body size does not match actual body size", and server frames
// (header + [seq] + size + json) were parsed as if json started at byte 4.

// Wall-clock-at-arrival stamping (the fix for the runaway transcript lag):
// finals anchor their trailing edge to arrival time and clamp the start so saved
// rows — sorted by startMs asc in the summary view — never reorder when 火山
// finalizes a long utterance right after a short one.
describe("nextFinalSegment (monotonic final timestamps)", () => {
  it("anchors endMs to arrival and derives start by subtracting duration", () => {
    expect(nextFinalSegment(10_000, 800, 0)).toEqual({ startMs: 9_200, endMs: 10_000 });
  });

  it("never lets a long late-finalized utterance start before the previous final", () => {
    // Short utterance finalizes first at t=10s.
    const a = nextFinalSegment(10_000, 800, 0);          // {9200, 10000}
    // A long (5s) utterance finalizes next at t=12s. Naively start=7000 (< a.end)
    // → would reorder; clamp pins it to a.endMs instead.
    const b = nextFinalSegment(12_000, 5_000, a.endMs);  // start clamped to 10000
    expect(b.startMs).toBe(10_000);
    expect(b.endMs).toBe(12_000);
    expect(b.startMs).toBeGreaterThanOrEqual(a.startMs); // monotonic, no overlap
  });

  it("advances same-tick batched finals by a minimal width instead of collapsing", () => {
    // Two finals in the same frame (same nowRel) can't advance via wall clock,
    // so each subsequent one gets a minimal positive width: endMs steps forward
    // by 1ms and startMs pins to the previous end — ordered, non-overlapping,
    // and crucially NOT start===end (which would be a zero-width ghost segment).
    const a = nextFinalSegment(8_000, 1_000, 0);
    const b = nextFinalSegment(8_000, 1_000, a.endMs);
    expect(b.endMs).toBe(a.endMs + 1);     // stepped forward, never rewound
    expect(b.startMs).toBe(a.endMs);       // pinned to previous end (no overlap)
    expect(b.endMs).toBeGreaterThan(b.startMs); // non-degenerate
    // A third same-tick final keeps stepping monotonically.
    const c = nextFinalSegment(8_000, 1_000, b.endMs);
    expect(c.startMs).toBe(b.endMs);
    expect(c.endMs).toBe(b.endMs + 1);
  });

  it("clamps start to 0 and tolerates negative duration", () => {
    expect(nextFinalSegment(500, 9_999, 0)).toEqual({ startMs: 0, endMs: 500 });
    expect(nextFinalSegment(1_000, -5, 0)).toEqual({ startMs: 1_000, endMs: 1_000 });
  });
});

describe("volc stt framing", () => {
  it("clientFrame prefixes the 4-byte big-endian payload length", () => {
    const payload = Buffer.from("hello", "utf8");
    const frame = clientFrame(0x1, 0x0, payload);
    expect(frame.length).toBe(4 + 4 + payload.length); // header + length + payload
    expect(frame.readUInt32BE(4)).toBe(payload.length);
    expect(frame.subarray(8).toString("utf8")).toBe("hello");
  });

  it("audio frames use serialization=none, config frames use JSON", () => {
    const audio = clientFrame(0x2, 0x0, Buffer.from([1, 2, 3]));
    expect(audio[2]! & 0xf0).toBe(0x00); // serialization nibble: none (raw audio)
    const cfg = clientFrame(0x1, 0x0, Buffer.from("{}"));
    expect(cfg[2]! & 0xf0).toBe(0x10); // serialization nibble: JSON
  });

  it("decodeServerFrame reads header + sequence + size + json (flags 0x1)", () => {
    const payload = Buffer.from(JSON.stringify({ result: { text: "你好" } }), "utf8");
    const seq = Buffer.alloc(4); seq.writeUInt32BE(1, 0);
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length, 0);
    const header = Buffer.from([0x11, 0x91, 0x10, 0x00]); // mt=0x9, flags=0x1 (has seq)
    const { messageType, flags, body } = decodeServerFrame(Buffer.concat([header, seq, size, payload]));
    expect(messageType).toBe(0x9);
    expect(flags).toBe(0x1);
    expect(JSON.parse(body).result.text).toBe("你好");
  });

  it("decodeServerFrame skips the sequence field only when flags&0x01", () => {
    const payload = Buffer.from("{}");
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length, 0);
    const header = Buffer.from([0x11, 0x92, 0x10, 0x00]); // flags=0x2 (last packet, no seq)
    const { flags, body } = decodeServerFrame(Buffer.concat([header, size, payload]));
    expect(flags).toBe(0x2);
    expect(body).toBe("{}");
  });
});

describe("VolcSttProvider 客户端主动关闭", () => {
  it("握手完成前就 close():不向上报错(否则会被计入熔断)", async () => {
    // 只接收连接、永不完成 WebSocket 握手,会话停留在 CONNECTING。
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const provider = new VolcSttProvider({ apiKey: "k", endpoint: `ws://127.0.0.1:${port}` });
      const errors: string[] = [];
      const closed: string[] = [];
      const session = provider.open({
        sessionId: "s1", meetingStartedAtMs: Date.now(),
        onPartial: () => undefined, onFinal: () => undefined,
        onError: (m) => errors.push(m), onClosed: (r) => closed.push(r),
      });
      await session.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toEqual([]);
      expect(closed).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
