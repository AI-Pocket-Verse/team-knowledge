// Abstraction for the speech-to-text providers used by the assistant
// meeting feature. There are TWO implementations:
//
//   - StubSttProvider (services/stt/stub.ts)
//       Emits synthetic "final" segments every N chunks. Always
//       available; no external keys. Used by tests / CI / local
//       dev when 火山 keys aren't configured.
//
//   - VolcSttProvider (services/stt/volc.ts)
//       Real bytedance/volcengine bigmodel streaming ASR. Picks
//       up VOLC_STT_APP_ID + VOLC_STT_ACCESS_TOKEN from env;
//       active when both are set.
//
// The registry (services/stt/registry.ts) picks volc when keys
// are present, falls back to stub otherwise. Meeting WS code
// only ever sees the SttProvider interface — switching providers
// is an env flip, no code change.

export interface SttSessionOpts {
  /** Meeting session id, for log/observability + correlation. */
  sessionId: string;
  /** Wall-clock at meeting start, used by callbacks to compute
   *  offsets that match MeetingTranscript.startMs / endMs (same
   *  reference frame as MeetingSession.createdAt). */
  meetingStartedAtMs: number;
  /** Best-effort partial — replaces any previously emitted partial.
   *  Caller broadcasts it but does NOT persist. */
  onPartial: (text: string, atMs: number) => void;
  /** Finalized segment — persisted to MeetingTranscript + broadcast. */
  onFinal: (text: string, startMs: number, endMs: number) => void;
  /** Non-fatal provider warning. Channel keeps streaming. */
  onError: (message: string) => void;
  /** The session ended UNEXPECTEDLY (upstream died — e.g. 火山 "session has
   *  ended" — or a degraded cooldown elapsed), NOT via a caller-initiated
   *  close(). The caller should drop this session and reopen a fresh one on the
   *  next chunk; without it a dead session keeps no-op-swallowing audio forever.
   *  Optional: providers that never die (stub) may omit it. */
  onClosed?: (reason: string) => void;
}

export interface SttSession {
  /** Push one MediaRecorder chunk (Opus container fragment) into the
   *  provider's pipeline. Caller invokes this for every host binary
   *  WS frame; backpressure is the provider's responsibility. */
  pushChunk(chunk: Buffer): void;
  /** Flush + close. Idempotent. Resolves once the provider has
   *  drained any in-flight segments. */
  close(): Promise<void>;
  /** Diagnostic: bytes queued in the provider's upstream socket send
   *  buffer (e.g. 火山 WS `bufferedAmount`). A monotonically growing
   *  value means audio is being produced faster than the upstream
   *  link drains it — the classic "transcript lags further and further
   *  behind" failure. Optional: providers without a socket return 0. */
  bufferedBytes?(): number;
  /** Recognition backlog, in ms of audio: (audio pushed) − (audio the
   *  upstream has transcribed so far). With 火山's send buffer empty
   *  (`bufferedBytes()===0`) this is the bytes 火山 has ACCEPTED but not
   *  yet recognized — i.e. how far behind real time the transcript runs.
   *  The meeting layer uses it to shed audio (catch-up) before the lag
   *  reaches tens/hundreds of seconds. Optional: providers that always
   *  keep up (stub) omit it → no backpressure applied. */
  lagMs?(): number;
}

export interface SttProvider {
  readonly name: "stub" | "volc";
  /** Open a per-meeting session. The returned object is hot — push
   *  chunks immediately. Implementations should tolerate close()
   *  being called before any chunks arrive (host opened mic and
   *  immediately stopped). */
  open(opts: SttSessionOpts): SttSession;
}
