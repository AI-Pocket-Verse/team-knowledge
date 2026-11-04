import { describe, it, expect } from "vitest";
import { shouldRestartCapture } from "./useAudioUpload";

describe("shouldRestartCapture", () => {
  const base = { muted: false, ctxState: "running" as AudioContextState };

  it("restarts when no frame for longer than the threshold while recording", () => {
    expect(shouldRestartCapture({ ...base, msSinceLastFrame: 4000, thresholdMs: 3000 })).toBe(true);
  });

  it("does not restart when muted", () => {
    expect(shouldRestartCapture({ ...base, muted: true, msSinceLastFrame: 9999, thresholdMs: 3000 })).toBe(false);
  });

  it("does not restart within the threshold", () => {
    expect(shouldRestartCapture({ ...base, msSinceLastFrame: 1000, thresholdMs: 3000 })).toBe(false);
  });

  it("does not restart when the context is suspended (visibilitychange resume handles it)", () => {
    expect(shouldRestartCapture({ ...base, ctxState: "suspended", msSinceLastFrame: 9999, thresholdMs: 3000 })).toBe(false);
  });
});
