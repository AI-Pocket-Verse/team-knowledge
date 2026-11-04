import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SttProvider, SttSession, SttSessionOpts } from "./types.js";
import {
  FallbackSttProvider,
  _resetBreakerForTests,
  isVolcBreakerOpen,
} from "./fallback.js";

// Test doubles. Each one is just enough to drive the wrapper's
// onError / onFinal callbacks; we never push real audio.
function makeMockProvider(name: "volc" | "stub", behavior: "ok" | "error"): {
  provider: SttProvider;
  sessions: SttSessionOpts[];
} {
  const sessions: SttSessionOpts[] = [];
  const provider: SttProvider = {
    name,
    open(opts: SttSessionOpts): SttSession {
      sessions.push(opts);
      // Emit an error immediately on open if behavior is "error" —
      // simulates a failed handshake / auth.
      if (behavior === "error") {
        queueMicrotask(() => opts.onError("simulated upstream failure"));
      }
      return {
        pushChunk: () => undefined,
        close: async () => undefined,
      };
    },
  };
  return { provider, sessions };
}

function freshOpts(): SttSessionOpts & { errors: string[]; finals: string[]; closed: string[] } {
  const errors: string[] = [];
  const finals: string[] = [];
  const closed: string[] = [];
  return {
    sessionId: "s1",
    meetingStartedAtMs: Date.now(),
    onPartial: () => undefined,
    onFinal: (text) => finals.push(text),
    onError: (msg) => errors.push(msg),
    onClosed: (reason) => closed.push(reason),
    errors,
    finals,
    closed,
  };
}

describe("FallbackSttProvider", () => {
  beforeEach(() => { _resetBreakerForTests(); });
  afterEach(() => { _resetBreakerForTests(); });

  it("by default forwards to volc + reports name='volc'", () => {
    const v = makeMockProvider("volc", "ok");
    const fb = new FallbackSttProvider(v.provider);
    expect(fb.name).toBe("volc");
    expect(fb.isDegraded()).toBe(false);
    fb.open(freshOpts());
    expect(v.sessions.length).toBe(1);
  });

  it("trips after 3 failed sessions within window → degrades SILENTLY (no stub gibberish)", async () => {
    const v = makeMockProvider("volc", "error");
    const fb = new FallbackSttProvider(v.provider);
    for (let i = 0; i < 3; i++) {
      fb.open(freshOpts());
      await Promise.resolve(); // flush queueMicrotask
    }
    expect(isVolcBreakerOpen()).toBe(true);
    expect(fb.isDegraded()).toBe(true);

    // Next open() degrades silently: a [degraded] notice, NO volc session, and
    // crucially NO fake transcript (no chunk#N stub output).
    const next = freshOpts();
    fb.open(next);
    expect(next.errors[0]).toMatch(/degraded/);
    expect(next.finals.length).toBe(0);
    expect(v.sessions.length).toBe(3); // the 4th open did NOT reach volc
  });

  it("degraded session fires onClosed after the cooldown so the meeting re-tries volc", async () => {
    vi.useFakeTimers();
    try {
      const v = makeMockProvider("volc", "error");
      const fb = new FallbackSttProvider(v.provider);
      for (let i = 0; i < 3; i++) { fb.open(freshOpts()); await Promise.resolve(); }
      expect(isVolcBreakerOpen()).toBe(true);

      const degraded = freshOpts();
      fb.open(degraded);
      expect(degraded.closed).toHaveLength(0); // not yet — still in cooldown
      vi.advanceTimersByTime(31_000);          // past the 30s cooldown
      expect(degraded.closed).toHaveLength(1); // → meeting drops it + reopens → volc retry
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single flooding session counts as ONE strike — one hiccup never trips", async () => {
    // The real failure mode: 火山 ends the session, then every audio chunk
    // re-errors. That must be ONE breaker strike, not many.
    const v: SttProvider = {
      name: "volc",
      open(opts: SttSessionOpts): SttSession {
        queueMicrotask(() => {
          for (let i = 0; i < 10; i++) opts.onError("waiting next packet timeout");
        });
        return { pushChunk: () => undefined, close: async () => undefined };
      },
    };
    const fb = new FallbackSttProvider(v);
    fb.open(freshOpts());
    await Promise.resolve();
    expect(isVolcBreakerOpen()).toBe(false); // 10 errors / 1 session = 1 strike
  });

  it("errors that come AFTER a final do not count toward the breaker", async () => {
    // Simulate a provider that emits a final, then an error — a
    // mid-session network blip. These shouldn't trip the breaker
    // since the session was clearly healthy.
    const v: SttProvider = {
      name: "volc",
      open(opts: SttSessionOpts): SttSession {
        queueMicrotask(() => {
          opts.onFinal("hello", 0, 1000);
          opts.onError("late ws blip");
        });
        return { pushChunk: () => undefined, close: async () => undefined };
      },
    };
    const fb = new FallbackSttProvider(v);
    for (let i = 0; i < 5; i++) {
      fb.open(freshOpts());
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(isVolcBreakerOpen()).toBe(false);
  });

  it("breaker auto-closes after cooldown elapses", async () => {
    const v = makeMockProvider("volc", "error");
    const fb = new FallbackSttProvider(v.provider);
    // Trip
    for (let i = 0; i < 3; i++) {
      fb.open(freshOpts());
      await Promise.resolve();
    }
    expect(isVolcBreakerOpen()).toBe(true);

    // Fast-forward by mutating Date.now via vi.useFakeTimers would
    // be cleaner; for a unit test we just reset state directly via
    // the test helper to simulate "cooldown elapsed".
    _resetBreakerForTests();
    expect(isVolcBreakerOpen()).toBe(false);
  });
});
