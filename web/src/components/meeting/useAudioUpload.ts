import { useCallback, useEffect, useRef, useState } from "react";
import { tr } from "@/i18n";

// Browser-side audio capture wrapper. Captures RAW PCM via Web Audio:
//   1. `getUserMedia` for mic access
//   2. an AudioContext at 16 kHz + an AudioWorklet (pcm-worklet.js) that emits
//      16-bit little-endian mono PCM frames off the main thread. Falls back to
//      the deprecated ScriptProcessorNode if the worklet can't load.
//   3. the same PCM frames drive a 0-100 mic level meter
// and hands frames to the caller via `onChunk` (wrapped in a Blob so
// the WS-send path is unchanged). Caller forwards them to the meeting
// WebSocket; the hook itself doesn't know about the network.
//
// WHY PCM (not MediaRecorder/Opus): 火山 sauc bigmodel ASR only accepts
// ogg/opus or raw PCM — NOT the `audio/webm;codecs=opus` that Chrome's
// MediaRecorder produces (it returns "unsupported format webm"). Capturing
// 16 kHz s16le PCM directly is the format the STT server consumes verbatim
// (services/stt/volc.ts declares format:"pcm"), with no server transcode.
//
// Frame size ≈ 128ms (2048 samples @ 16 kHz) — low STT latency, one binary
// WS frame per callback.

export type AudioUploadState =
  | { status: "idle"; error: null }
  | { status: "requesting"; error: null }   // mic permission prompt up
  | { status: "denied";   error: string }   // user said no
  | { status: "unavailable"; error: string } // no getUserMedia / no MediaRecorder
  | { status: "recording"; error: null }
  | { status: "muted";    error: null }
  | { status: "error";    error: string };

export interface AudioUpload {
  state: AudioUploadState;
  /** 0-100. Updated ~10x per second from a connected analyser. */
  micLevel: number;
  /** Request mic + start streaming. Returns true if started. */
  start: () => Promise<boolean>;
  /** Stop streaming + release the track. Idempotent. */
  stop: () => void;
  /** Soft-mute: keep the track alive (so the green dot doesn't
   *  disappear in the browser's tab bar) but stop forwarding chunks
   *  upstream. Re-enabling resumes from the next chunk boundary. */
  setMuted: (m: boolean) => void;
}

interface Options {
  /** Called for each MediaRecorder chunk (~500ms). Caller forwards
   *  to the meeting WS. Not called while muted. */
  onChunk: (chunk: Blob) => void;
  /** Stable callback for non-fatal warnings (browser denied
   *  permission etc). Optional — defaults to console.warn. */
  onError?: (msg: string) => void;
}

// Target sample rate handed to the STT server. 16 kHz mono matches
// services/stt/volc.ts (rate:16000, channel:1) and every mainstream ASR.
const TARGET_SAMPLE_RATE = 16_000;
// ScriptProcessor buffer (power of 2). 2048 @ 16 kHz ≈ 128ms per frame.
const PCM_BUFFER_SIZE = 2048;

// NOTE — we deliberately do NOT do client-side voice-activity gating. An earlier
// version dropped "silent" frames to lighten 火山's load, but it backfired:
//   1. 火山 relies on the silence between utterances to do its OWN endpointing;
//      removing it made 火山 mis-segment — sentences ran together / got revised,
//      so already-shown text appeared to be "overwritten".
//   2. quiet speech sat below the RMS threshold and got dropped, so those words
//      were never recognized at all.
// Sending every frame and letting 火山 handle silence/endpointing gives the
// cleanest transcript. Latency (if 火山 lags) is handled server-side by the
// recycle safety net (meeting-ws.ts STT_RECYCLE_MS) + a faster 火山 model.

// ─── Capture stall self-heal ─────────────────────────────────
// A backgrounded/minimized tab keeps recording as long as the mic track stays
// active, but capture can still silently stall (the AudioContext glitches while
// nominally "running", or a frame never arrives). A watchdog rebuilds the
// capture graph when no PCM frame has arrived for STALL_RESTART_MS while we're
// recording, not muted, and the context is running (a suspended context is the
// visibilitychange handler's job, not a stall). The server stitches the gap via
// its stop/restart timestamp continuity.
const STALL_RESTART_MS = 3_000;
const WATCHDOG_INTERVAL_MS = 1_000;

export function shouldRestartCapture(o: {
  muted: boolean;
  ctxState: AudioContextState;
  msSinceLastFrame: number;
  thresholdMs: number;
}): boolean {
  if (o.muted) return false;
  if (o.ctxState !== "running") return false; // suspended → resume handles it
  return o.msSinceLastFrame > o.thresholdMs;
}

// Float32 [-1,1] PCM → 16-bit little-endian PCM (what 火山 format:"pcm" wants).
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export function useAudioUpload(opts: Options): AudioUpload {
  const { onChunk, onError } = opts;
  const [state, setState] = useState<AudioUploadState>({ status: "idle", error: null });
  const [micLevel, setMicLevel] = useState(0);

  // Latest callbacks captured into refs so the start/stop closures
  // don't restart whenever the parent re-renders with a new arrow.
  const onChunkRef = useRef(onChunk);
  const onErrorRef = useRef(onError);
  useEffect(() => { onChunkRef.current = onChunk; }, [onChunk]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // "Should-be-recording" sentinel. Set true the moment a user-intent
  // start() begins, set false by stop()/cleanup(). The stall watchdog
  // rebuilds capture by calling cleanup() then `start()` on a later
  // microtask; if stop()/endMeeting() runs in that window, this flag is
  // already false, so start() bails BEFORE re-acquiring getUserMedia —
  // preventing a hot mic with no UI after an intentional stop. start()
  // re-checks it after each await (getUserMedia / worklet load) so a
  // stop landing mid-acquire still tears the half-built graph down.
  const desiredRecordingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mutedRef = useRef(false);
  // visibilitychange handler: browsers suspend a backgrounded tab's
  // AudioContext, which silently stops capture. We can't prevent the
  // suspension, but we resume() the moment the tab returns to the
  // foreground so recording picks back up instead of staying dead.
  const visibilityHandlerRef = useRef<(() => void) | null>(null);
  // Stall self-heal: timestamp of the last PCM frame, the watchdog timer, and a
  // stable handle to start() so the watchdog can rebuild capture.
  const lastFrameAtRef = useRef(0);
  const watchdogRef = useRef<number | null>(null);
  const startRef = useRef<(() => Promise<boolean>) | null>(null);

  const cleanup = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (visibilityHandlerRef.current) {
      document.removeEventListener("visibilitychange", visibilityHandlerRef.current);
      visibilityHandlerRef.current = null;
    }
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { /* noop */ }
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current = null;
    }
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch { /* noop */ }
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch { /* noop */ }
      sourceRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop(); } catch { /* noop */ }
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { void audioCtxRef.current.close(); } catch { /* noop */ }
      audioCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const stop = useCallback(() => {
    // Clear the sentinel FIRST: this is an intentional stop, so any
    // watchdog rebuild already queued (cleanup() ran, start() pending on
    // a microtask) must see "should not be recording" and bail before
    // it re-opens the mic.
    desiredRecordingRef.current = false;
    cleanup();
    setState({ status: "idle", error: null });
  }, [cleanup]);

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    // Keep the underlying audio track enabled so the browser tab's
    // "recording" indicator stays on — that's a Chrome guideline:
    // hiding the indicator while audio is being actively captured
    // is misleading. We just stop forwarding chunks upstream.
    setState((s) => {
      if (s.status === "recording" || s.status === "muted") {
        return { status: m ? "muted" : "recording", error: null };
      }
      return s;
    });
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    // Mark "should be recording" up front. stop()/cleanup() flips this
    // false; we re-check it after every await below so an intentional
    // stop that lands mid-acquire (incl. a watchdog rebuild racing a
    // stop) can't leave a hot mic running with no UI.
    desiredRecordingRef.current = true;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState({ status: "unavailable", error: tr("meeting.audio.noMic") });
      return false;
    }
    const AudioCtx = typeof window !== "undefined"
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
    if (!AudioCtx) {
      setState({ status: "unavailable", error: tr("meeting.audio.noWebAudio") });
      return false;
    }

    setState({ status: "requesting", error: null });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Force 16 kHz where the browser allows it — matches every
          // mainstream STT API's preferred sample rate, saves a
          // resample on the server side.
          sampleRate: { ideal: 16_000 },
          channelCount: { ideal: 1 },
        },
      });
    } catch (err) {
      const e = err as DOMException;
      // NotAllowedError (denied) and PermissionDeniedError (legacy)
      // mean the user clicked "block" — surface a stable explanation.
      if (e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError") {
        setState({ status: "denied", error: tr("meeting.audio.denied") });
      } else if (e?.name === "NotFoundError" || e?.name === "DevicesNotFoundError") {
        setState({ status: "unavailable", error: tr("meeting.audio.notFound") });
      } else {
        setState({ status: "error", error: e?.message ?? tr("meeting.audio.initFailed") });
      }
      return false;
    }

    // getUserMedia just resolved — but stop()/endMeeting() may have run
    // during the permission round-trip (incl. a watchdog rebuild racing
    // a stop). If we're no longer wanted, immediately release the track
    // we just acquired and bail so the mic LED never lights up.
    if (!desiredRecordingRef.current) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* noop */ }
      }
      return false;
    }

    streamRef.current = stream;

    // AudioContext pinned to 16 kHz: the browser resamples the mic stream
    // (often 48 kHz) down to 16 kHz for us, so the samples we read are already
    // at the STT server's target rate — no manual resampling needed.
    let ctx: AudioContext;
    try {
      ctx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
    } catch (err) {
      cleanup();
      setState({ status: "error", error: (err as Error).message });
      return false;
    }
    audioCtxRef.current = ctx;
    // Autoplay policy can leave the context "suspended" until a user gesture;
    // clicking 录制 is that gesture, so resume is allowed here.
    try { await ctx.resume(); } catch { /* best-effort */ }
    // Resume on return to foreground — a backgrounded tab may have suspended
    // the context (browser limit; we can't keep it running in the background,
    // only recover promptly when the user comes back).
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // Reset the stall clock first so the watchdog doesn't count the
        // backgrounded gap (when no frames arrived) as a stall to restart.
        lastFrameAtRef.current = Date.now();
        if (audioCtxRef.current?.state === "suspended") {
          void audioCtxRef.current.resume().catch(() => { /* best-effort */ });
        }
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    visibilityHandlerRef.current = onVisible;

    // Last chance to bail before we wire up + arm the watchdog: if an
    // intentional stop landed during ctx.resume() (or the upcoming
    // worklet load), tear down whatever we've built and don't start
    // capturing. cleanup() is idempotent, so this is safe even if stop()
    // already ran cleanup once.
    if (!desiredRecordingRef.current) {
      cleanup();
      return false;
    }

    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;

    // Forward every finished PCM frame to the caller (→ meeting WS). Used by both
    // the AudioWorklet (primary) and ScriptProcessor (fallback) paths. Wrapped in
    // a Blob so the WS-send path (which already handles Blobs) is unchanged; the
    // bytes on the wire are raw s16le PCM. No client-side gating — 火山 does its
    // own silence detection + endpointing (see the NOTE near the constants).
    let sent = 0;
    const handlePcm = (pcm: ArrayBuffer, level: number) => {
      // Liveness stamp for the stall watchdog — updated on every produced frame,
      // so a stalled graph (no frames at all) is distinguishable from a quiet but
      // healthy one.
      lastFrameAtRef.current = Date.now();
      setMicLevel(level);
      if (mutedRef.current) return;
      sent += 1;
      if (import.meta.env.DEV && (sent <= 3 || sent % 20 === 0)) {
        console.log("[meeting] pcm frame → ws", { n: sent, bytes: pcm.byteLength });
      }
      try { onChunkRef.current(new Blob([pcm], { type: "audio/pcm" })); }
      catch (err) {
        console.warn("[meeting] onChunk threw", err);
        onErrorRef.current?.((err as Error).message);
      }
    };

    // Primary path: AudioWorklet (off the main thread; no deprecation warning).
    // The module is a same-origin public asset — a blob: URL would be blocked by
    // the app's CSP (script-src 'self'). Output is left silent, so connecting to
    // destination doesn't echo the mic; it's only there so the node is pulled.
    let captureStarted = false;
    try {
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`);
      // A stop() during the module fetch would have torn down ctx; don't
      // wire nodes onto a dead graph (and re-open capture) after it.
      if (!desiredRecordingRef.current) { cleanup(); return false; }
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        handlePcm(e.data.pcm, e.data.level);
      };
      source.connect(node);
      node.connect(ctx.destination);
      workletNodeRef.current = node;
      captureStarted = true;
      // The server + 火山 + the WAV header all assume 16 kHz. If the browser
      // ignored our 16 kHz request and gave a higher rate, we'd be shipping
      // e.g. 48 kHz samples LABELED as 16 kHz → 火山 buffers the 3× excess and
      // the transcript falls further and further behind (the "几十秒后才转录"
      // bug). Make that loud so it's obvious in the console.
      if (ctx.sampleRate !== TARGET_SAMPLE_RATE) {
        console.warn("[meeting] ⚠ AudioContext sampleRate is NOT 16000 — STT will lag/drift", { actual: ctx.sampleRate, expected: TARGET_SAMPLE_RATE });
        onErrorRef.current?.(tr("meeting.audio.sampleRate", { rate: ctx.sampleRate }));
      } else if (import.meta.env.DEV) {
        console.log("[meeting] PCM capture started (AudioWorklet)", { sampleRate: ctx.sampleRate });
      }
    } catch (err) {
      console.warn("[meeting] AudioWorklet unavailable — falling back to ScriptProcessor", err);
    }

    // Fallback: deprecated-but-universal ScriptProcessorNode. Only used if the
    // worklet module failed to load, so the deprecation warning is the
    // exception, not the rule.
    if (!captureStarted) {
      const processor = ctx.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (ev: AudioProcessingEvent) => {
        const input = ev.inputBuffer.getChannelData(0); // Float32, 16 kHz mono
        let sum = 0;
        for (let i = 0; i < input.length; i++) { const d = input[i]!; sum += d * d; }
        const level = Math.min(100, Math.round(Math.sqrt(sum / input.length) * 200));
        handlePcm(floatTo16BitPCM(input), level);
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      processorRef.current = processor;
      if (import.meta.env.DEV) {
        console.log("[meeting] PCM capture started (ScriptProcessor fallback)", {
          sampleRate: ctx.sampleRate, bufferSize: PCM_BUFFER_SIZE,
        });
      }
    }

    mutedRef.current = false;
    // Seed the stall clock + arm the watchdog now that frames are about to flow.
    lastFrameAtRef.current = Date.now();
    if (watchdogRef.current !== null) window.clearInterval(watchdogRef.current);
    watchdogRef.current = window.setInterval(() => {
      const stalled = shouldRestartCapture({
        muted: mutedRef.current,
        ctxState: audioCtxRef.current?.state ?? "closed",
        msSinceLastFrame: Date.now() - lastFrameAtRef.current,
        thresholdMs: STALL_RESTART_MS,
      });
      if (!stalled) return;
      console.warn("[meeting] capture stalled — rebuilding audio graph");
      cleanup();                 // clears this watchdog + tears down the dead graph
      void startRef.current?.();  // rebuild; server stitches the gap
    }, WATCHDOG_INTERVAL_MS);
    setState({ status: "recording", error: null });
    return true;
  }, [cleanup]);

  // Stable handle so the watchdog (created inside start) can re-invoke start().
  startRef.current = start;

  // Always tear down on unmount — leaving the mic open is a privacy
  // bug. Most browsers also flash a notification when audio capture
  // outlives the page, so failure here is loud. Clear the sentinel too
  // so any watchdog rebuild microtask queued just before unmount bails
  // instead of re-acquiring the mic into a dead component.
  useEffect(() => () => { desiredRecordingRef.current = false; cleanup(); }, [cleanup]);

  return { state, micLevel, start, stop, setMuted };
}
