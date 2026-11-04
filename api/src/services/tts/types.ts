// Abstraction for text-to-speech providers used by the assistant
// meeting feature. Same shape as the STT abstraction:
//
//   - StubTtsProvider (tts/stub.ts)
//       Returns null URL → frontend just doesn't play audio.
//       Always available; default in dev/CI.
//
//   - VolcTtsProvider (tts/volc.ts)
//       Real bytedance/volcengine TTS. Activates when
//       VOLC_TTS_APP_ID + VOLC_TTS_ACCESS_TOKEN are set.
//
// The registry (tts/registry.ts) picks volc when keys are present,
// falls back to stub otherwise.

export interface TtsSynthesisRequest {
  /** The text to synthesize (max ~500 chars for in-meeting clips). */
  text: string;
  /** Meeting + comment ids used to namespace the on-disk audio file. */
  sessionId: string;
  commentId: string;
  /** Optional per-sentence sequence number for streamed assistant comments.
   *  When present the on-disk file is `<commentId>-<seq>.mp3` (one clip
   *  per sentence) instead of `<commentId>.mp3` (the whole-comment clip).
   *  Lets sentence 0's audio play while sentence 1's text still streams. */
  seq?: number;
  /** Optional voice preset name; provider-specific. */
  voice?: string;
}

export interface TtsProvider {
  readonly name: "stub" | "volc";
  /** Synthesize and return a URL the frontend can play with
   *  <audio src=...>. Returns null when synthesis is disabled or
   *  the provider failed — the comment text broadcast still goes
   *  out, just without audio. */
  synthesize(req: TtsSynthesisRequest): Promise<{ audioUrl: string | null }>;
}
