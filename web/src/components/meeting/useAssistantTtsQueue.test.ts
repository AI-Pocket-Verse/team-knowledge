import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAssistantTtsQueue } from "./useAssistantTtsQueue";
import type { AssistantTtsChunk } from "./useMeetingWS";

vi.mock("@/lib/api", () => ({ API_BASE: "/api" }));

// Minimal fake <audio> that records add/removeEventListener calls and lets
// tests drive `ended`/`error` manually. play() resolves immediately.
class FakeAudio {
  loop = false;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());
  constructor(public src: string) {}
}

let lastAudio: FakeAudio | null = null;

beforeEach(() => {
  lastAudio = null;
  vi.stubGlobal("Audio", vi.fn(function (src: string) {
    lastAudio = new FakeAudio(src);
    return lastAudio;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function chunk(seq: number): AssistantTtsChunk {
  return { commentId: "c1", seq, audioUrl: `/meeting-tts/c1-${seq}.mp3` };
}

describe("useAssistantTtsQueue", () => {
  it("removes ended/error listeners when TTS is toggled off mid-playback", () => {
    const { result, rerender } = renderHook(
      ({ chunks, enabled }: { chunks: AssistantTtsChunk[]; enabled: boolean }) =>
        useAssistantTtsQueue(chunks, enabled),
      { initialProps: { chunks: [chunk(0)], enabled: true } },
    );

    // A clip started playing → listeners were registered.
    expect(result.current.playingId).toBe("c1");
    expect(lastAudio).not.toBeNull();
    expect(lastAudio!.addEventListener).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(lastAudio!.addEventListener).toHaveBeenCalledWith("error", expect.any(Function));

    // Toggle TTS off mid-playback.
    act(() => {
      rerender({ chunks: [chunk(0)], enabled: false });
    });

    // Both listeners must be torn down (no leak), the clip paused, idle.
    expect(lastAudio!.removeEventListener).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(lastAudio!.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(lastAudio!.pause).toHaveBeenCalled();
    expect(result.current.playingId).toBeNull();
  });
});
