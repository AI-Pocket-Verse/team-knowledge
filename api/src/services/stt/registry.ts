import type { SttProvider } from "./types.js";
import { StubSttProvider } from "./stub.js";
import { VolcSttProvider } from "./volc.js";
import { FallbackSttProvider } from "./fallback.js";
import { getVolcSttCreds } from "../settings.js";

// STT provider is resolved by reading credentials from
// Setting table > env > null:
//   - DB row `volc.stt.creds` OR env (VOLC_STT_APP_ID +
//     VOLC_STT_ACCESS_TOKEN) → VolcSttProvider
//   - neither → StubSttProvider (synthetic, always available)
//
// Resolution is cached with a short TTL so admin DB edits propagate
// without a server restart but every meeting open doesn't hit the
// DB. Matches the LLM registry pattern (services/llm/registry.ts).
//
// The async signature ripples to callers (speaker.ts awaits this);
// that's a small price for not having a separate "reload settings"
// admin endpoint.

const TTL_MS = 30_000;

let cached: { provider: SttProvider; at: number } | null = null;
// Held across an in-flight DB lookup so concurrent callers don't
// duplicate the round-trip while the cache is empty.
let inflight: Promise<SttProvider> | null = null;
// Monotonic generation counter — bumped on every invalidate. The
// IIFE captures the generation BEFORE its DB read and refuses to
// assign to `cached` if the counter has moved since. Without this,
// an admin rotation that races with an in-flight resolver would
// overwrite the newly-cached provider with the stale one and keep
// using revoked credentials for the full TTL window.
let generation = 0;

export async function getSttProvider(): Promise<SttProvider> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.provider;
  if (inflight) return inflight;
  const myGeneration = generation;
  inflight = (async () => {
    try {
      const creds = await getVolcSttCreds();
      // When creds are configured, wrap volc in a circuit breaker so a
      // persistent upstream outage degrades quietly (no transcript) for a
      // cooldown instead of cascading failures into every meeting. The breaker
      // is process-global (see services/stt/fallback.ts). Without creds we use
      // the synthetic stub directly — that's the dev/CI "no 火山 keys" mode.
      const provider: SttProvider = creds
        ? new FallbackSttProvider(new VolcSttProvider(creds))
        : new StubSttProvider();
      // Only publish to the cache if no invalidation happened
      // during our async work. If `generation` moved, a newer
      // resolver (with fresh creds) already owns the cache slot.
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

// Drops the cached provider so the next getSttProvider() re-reads
// credentials from DB > env. Called by the admin settings route
// after a creds update + by tests that need to flip providers
// mid-run.
export function invalidateSttProviderCache(): void {
  cached = null;
  inflight = null;
  generation++;
}

// Alias kept for the existing test suite's import path.
export const _resetSttProviderForTests = invalidateSttProviderCache;
