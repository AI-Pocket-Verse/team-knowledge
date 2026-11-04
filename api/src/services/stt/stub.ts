import type { SttProvider, SttSession, SttSessionOpts } from "./types.js";

// Synthetic STT for dev / CI / tests. Emits canned partial
// progress every chunk and a "final" segment every Nth chunk.
// The text is just `chunk #<n>` — useful enough to verify the
// transcript pane renders + the DB persistence works without
// burning real 火山 API quota.
//
// To exercise a longer flow, the test code can send N chunks and
// expect ceil(N/CHUNKS_PER_FINAL) MeetingTranscript rows. The
// CHUNK_DURATION_MS constant matches the frontend's MediaRecorder
// timeslice (500ms) so the synthetic startMs / endMs offsets line
// up with what a real Opus stream would produce.

const CHUNKS_PER_FINAL = 4;        // 4 × 500ms = 2s segments
const CHUNK_DURATION_MS = 500;
const PARTIAL_EVERY_N_CHUNKS = 1;  // every chunk emits a partial

export class StubSttProvider implements SttProvider {
  readonly name = "stub" as const;

  open(opts: SttSessionOpts): SttSession {
    let chunkIndex = 0;
    let segmentStartMs = 0;
    let segmentText = "";
    let closed = false;

    function chunkOffsetMs(): number {
      // chunkIndex was just incremented when we call this — the
      // chunk that arrived spans [(idx-1)*500, idx*500].
      return chunkIndex * CHUNK_DURATION_MS;
    }

    function flushFinal(): void {
      const endMs = chunkOffsetMs();
      // Only emit a final if we accumulated any text since the last
      // boundary — close() at idle shouldn't fabricate an empty row.
      if (segmentText.length > 0) {
        opts.onFinal(segmentText, segmentStartMs, endMs);
      }
      segmentStartMs = endMs;
      segmentText = "";
    }

    return {
      pushChunk(_chunk: Buffer): void {
        if (closed) return;
        chunkIndex += 1;
        // Each chunk extends the current segment's text.
        segmentText = segmentText ? `${segmentText} chunk#${chunkIndex}` : `chunk#${chunkIndex}`;
        if (chunkIndex % PARTIAL_EVERY_N_CHUNKS === 0) {
          opts.onPartial(segmentText, segmentStartMs);
        }
        if (chunkIndex % CHUNKS_PER_FINAL === 0) {
          flushFinal();
        }
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        // Drain whatever's accumulated below a CHUNKS_PER_FINAL
        // boundary so the trailing audio still becomes a final row.
        flushFinal();
      },
    };
  }
}
