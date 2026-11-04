import { useEffect, useRef, useState } from "react";
import type { AssistantTtsChunk } from "./useMeetingWS";
import { API_BASE } from "@/lib/api";

// Host-only TTS playback queue for assistant's STREAMED comments.
//   * Watches the `assistantTtsChunks` list from useMeetingWS — one entry
//     per sentence, emitted live as each sentence finishes synthesizing
//     while the rest of the comment text is still streaming in.
//   * Plays them FIFO in server arrival order (already (comment, seq)
//     ordered) via a single <audio> element so two near-simultaneous
//     sentences don't talk over each other — sentence 0 can start
//     before sentence 1's text has even arrived.
//   * `enabled` toggles the entire pipeline — when off, new chunks are
//     still queued (kept short, capped at MAX_QUEUE) but not played.
//     Toggling back on resumes from the head.
//
// Only the meeting host should run this hook — running it on viewers
// would cause everyone's device to play independently, drowning out
// the host's room speaker. The caller gates the hook on role === "host".

const MAX_QUEUE = 6;

export function useAssistantTtsQueue(chunks: AssistantTtsChunk[], enabled: boolean): {
  /** Currently playing comment id, or null when idle. */
  playingId: string | null;
  /** Queued (not-yet-played) clip count, for UI badge. */
  queuedCount: number;
} {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<AssistantTtsChunk[]>([]);
  const playedKeysRef = useRef<Set<string>>(new Set());
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  // Full teardown for the CURRENT clip: removeEventListener + pause + null
  // out audioRef + clear playingId. Stored in a ref so paths other than the
  // drain effect (off-toggle, unmount) can run the *same* cleanup — without
  // this, the off-toggle path used to pause + null audioRef while leaking the
  // ended/error listeners that were only removed inside the drain closure.
  const teardownRef = useRef<() => void>(() => {});

  // Watch the chunk list — append any never-seen clip to the queue.
  // Cap at MAX_QUEUE so a flurry of sentences doesn't backlog audio
  // that's already stale.
  useEffect(() => {
    for (const c of chunks) {
      const key = `${c.commentId}-${c.seq}`;
      if (playedKeysRef.current.has(key)) continue;
      // Tag as known immediately — even if `enabled === false` we don't
      // want to re-add when the chunks array re-renders.
      playedKeysRef.current.add(key);
      queueRef.current.push(c);
      if (queueRef.current.length > MAX_QUEUE) {
        queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE);
      }
    }
    setQueuedCount(queueRef.current.length);
  }, [chunks]);

  // Drain the queue when nothing's playing + we're enabled.
  useEffect(() => {
    if (!enabled) return;
    if (playingId !== null) return;
    const next = queueRef.current.shift();
    if (!next) return;
    setQueuedCount(queueRef.current.length);

    // audioUrl is root-relative (/meeting-tts/<id>-<seq>.mp3); serve it through
    // the gateway's API base or it 404s at the site root and never plays.
    const audio = new Audio(`${API_BASE}${next.audioUrl}`);
    // Each synthesized clip plays exactly once — never loop. (Default is
    // already false; set explicitly so intent is unmistakable and a clip
    // can't restart itself after it ends.)
    audio.loop = false;
    audioRef.current = audio;
    setPlayingId(next.commentId);
    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onErr);
      try { audio.pause(); } catch { /* noop */ }
      audioRef.current = null;
      teardownRef.current = () => {};
      setPlayingId(null);
    };
    const onEnded = () => cleanup();
    const onErr = () => cleanup();
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onErr);
    // Expose this clip's full teardown so the off-toggle / unmount paths
    // tear down the SAME listeners instead of leaking them.
    teardownRef.current = cleanup;
    void audio.play().catch(() => cleanup());
  }, [enabled, playingId, queuedCount]);

  // When the host toggles TTS off mid-playback, stop the current clip
  // (queue keeps its remaining items for if they turn it back on quickly).
  // Run the full teardown (incl. removeEventListener) so the ended/error
  // listeners don't leak per off-toggle.
  useEffect(() => {
    if (!enabled) teardownRef.current();
  }, [enabled]);

  // Cleanup on unmount — full teardown of the current clip + drop queue.
  useEffect(() => () => {
    teardownRef.current();
    queueRef.current.length = 0;
  }, []);

  return { playingId, queuedCount };
}
