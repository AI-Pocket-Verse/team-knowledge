import type { TtsProvider, TtsSynthesisRequest } from "./types.js";

// No-op TTS provider for dev / CI / when the user hasn't wired
// real TTS keys yet. Returns null URL so the frontend just
// renders the comment text without trying to play audio.
//
// We deliberately do NOT generate a fake silent mp3 here — the
// frontend audio queue treats null as "skip this one", which is
// exactly the desired behavior. Generating a fake file would
// require ffmpeg / a static asset and add no value.
export class StubTtsProvider implements TtsProvider {
  readonly name = "stub" as const;
  async synthesize(_req: TtsSynthesisRequest): Promise<{ audioUrl: string | null }> {
    return { audioUrl: null };
  }
}
