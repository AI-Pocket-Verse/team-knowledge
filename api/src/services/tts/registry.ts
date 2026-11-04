import type { TtsProvider } from "./types.js";
import { StubTtsProvider } from "./stub.js";
import { VolcTtsProvider } from "./volc.js";
import { getVolcTtsCreds } from "../settings.js";

// TTS provider resolved by reading credentials from
// Setting table > env > null:
//   - DB row `volc.tts.creds` OR env (VOLC_TTS_APP_ID +
//     VOLC_TTS_ACCESS_TOKEN) → VolcTtsProvider
//   - neither → StubTtsProvider (null URL, frontend renders text
//     only)
//
// Cached for 30s like the LLM + STT registries so admin DB
// updates propagate without a restart. Async signature ripples
// to speaker.ts's `getTtsProvider()` call site.

const TTL_MS = 30_000;

let cached: { provider: TtsProvider; at: number } | null = null;
let inflight: Promise<TtsProvider> | null = null;
// Generation counter — see services/stt/registry.ts for the full
// rationale. Prevents an in-flight resolver from overwriting a
// freshly-cached provider after an admin key rotation.
let generation = 0;

export async function getTtsProvider(): Promise<TtsProvider> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.provider;
  if (inflight) return inflight;
  const myGeneration = generation;
  inflight = (async () => {
    try {
      const creds = await getVolcTtsCreds();
      const provider: TtsProvider = creds
        ? new VolcTtsProvider(creds)
        : new StubTtsProvider();
      if (generation === myGeneration) {
        cached = { provider, at: Date.now() };
      }
      return provider;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateTtsProviderCache(): void {
  cached = null;
  inflight = null;
  generation++;
}

// Alias for the existing test helper convention.
export const _resetTtsProviderForTests = invalidateTtsProviderCache;
