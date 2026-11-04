import { env as procEnv } from "node:process";
import type { LLMProvider } from "./types.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { getProvider } from "./registry.js";

// Summarizer-tier provider: a SECOND, smaller-model instance for the
// rolling-summary refresh path. Summaries are short, latency-tolerant,
// and run on every ~5 messages — running them on the same Sonnet
// instance that serves user chat would pay 10× the per-turn cost for
// no quality benefit. Use Haiku 4.5 by default; opt out via env to
// reuse the main provider (e.g. when only Codex is available).
//
// Behavior:
//   - DEFAULT (active provider is Claude) → new ClaudeCliProvider
//     with `--model claude-haiku-4-5`. Configurable via
//     SUMMARY_MODEL env (any model id the Claude CLI accepts).
//   - SUMMARY_PROVIDER=main → fall back to the active provider
//     unchanged. Use this when the host doesn't have Haiku installed
//     or when you specifically want both calls on the same model
//     (e.g. for deterministic test setup).
//   - Active provider is NOT Claude (e.g. Codex) → fall back to the
//     active provider; Codex doesn't expose a separate cheap model.

let cachedHaikuClaude: ClaudeCliProvider | null = null;

export async function getSummaryProvider(): Promise<LLMProvider> {
  // Explicit opt-out — reuse main provider.
  if (procEnv.SUMMARY_PROVIDER === "main") return getProvider();

  // If main provider is Claude, use a Claude-Haiku sibling.
  const main = await getProvider();
  if (main.name !== "claude") return main;

  const model = procEnv.SUMMARY_MODEL ?? "claude-haiku-4-5";
  // Memoize: a second ClaudeCliProvider per process is fine; we
  // don't want to spawn three+ if multiple summarize calls race.
  if (!cachedHaikuClaude || (cachedHaikuClaude as unknown as { model?: string }).model !== model) {
    cachedHaikuClaude = new ClaudeCliProvider({ model });
  }
  return cachedHaikuClaude;
}
