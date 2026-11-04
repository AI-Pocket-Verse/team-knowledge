import { memo, useLayoutEffect, useRef } from "react";
import type { MeetingTranscriptRow } from "@team-knowledge/shared";
import type { ActivePartial } from "./useMeetingWS";
import { beijingParts } from "@/lib/tz";

// Scrolling transcript pane shown in the meeting room while audio is flowing.
// Two layers:
//   - Final segments: rendered black, each with an "hh:mm" wall-clock prefix.
//   - Active partial (the in-flight words STT is refining): grey italic below
//     the finals so it's visually clear it can still change.
//
// PERFORMANCE — long meetings + a fast partial stream used to freeze this view:
// the partial updates tens of times per second, and a naive render re-rendered
// the entire (thousands-of-rows) finals list each time + forced a reflow. Fixes:
//   1. The finals list is a memo() component keyed on the `transcripts` array
//      ref — a partial-only update doesn't change that ref, so the whole list
//      is skipped and only the single partial line re-renders.
//   2. Each row is memo()'d, so adding one final re-renders just the new row.
//   3. Only the most recent MAX_RENDERED_FINALS are mounted (the full record is
//      in the post-meeting summary); thousands of live DOM rows are the reflow
//      cost we're avoiding.
//
// Auto-scroll is "stick to bottom" — but ONLY when the user is already near the
// bottom, so scrolling up to re-read an older line isn't yanked away.

const STICK_THRESHOLD_PX = 48;
// Cap the live DOM. Older lines remain available in the meeting summary.
const MAX_RENDERED_FINALS = 250;

// Render a wall-clock hh:mm label (24h, Beijing time) for an absolute epoch-ms
// instant. Segment/partial offsets are added to the meeting start first.
function formatClock(epochMs: number): string {
  const { hour, minute } = beijingParts(new Date(epochMs));
  return `${hour}:${minute}`;
}

const FinalRow = memo(function FinalRow({ time, text }: { time: string; text: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 select-none text-xs text-muted tabular-nums pt-0.5">{time}</span>
      <span className="flex-1 text-fg">{text}</span>
    </div>
  );
});

const FinalsList = memo(function FinalsList({
  transcripts, startedAtMs,
}: { transcripts: MeetingTranscriptRow[]; startedAtMs: number }) {
  const overflow = transcripts.length - MAX_RENDERED_FINALS;
  const shown = overflow > 0 ? transcripts.slice(-MAX_RENDERED_FINALS) : transcripts;
  return (
    <>
      {overflow > 0 && (
        <div className="select-none text-center text-xs text-muted/60">
          … 仅显示最近 {MAX_RENDERED_FINALS} 条，完整记录见会议结束后的纪要 …
        </div>
      )}
      {shown.map((row) => (
        <FinalRow key={row.id} time={formatClock(startedAtMs + row.startMs)} text={row.text} />
      ))}
    </>
  );
});

interface Props {
  transcripts: MeetingTranscriptRow[];
  activePartial: ActivePartial | null;
  /** Wall-clock epoch (ms) of the meeting start = MeetingSession.createdAt.
   *  Segment `startMs` / partial `atMs` are offsets from this. */
  startedAtMs: number;
  /** Shown when there's neither a final nor a partial yet. */
  emptyHint?: string;
}

export function LiveTranscript({ transcripts, activePartial, startedAtMs, emptyHint = "等待主持人开始说话…" }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // `stick` starts true (initial render scrolls to bottom). Flips false when the
  // user scrolls away; flips back true when they return near the bottom. A ref,
  // to avoid re-renders on every scroll event.
  const stickRef = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [transcripts.length, activePartial?.text]);
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < STICK_THRESHOLD_PX;
  }

  const isEmpty = transcripts.length === 0 && !activePartial;

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full min-h-[12rem] overflow-y-auto rounded-xl border border-line bg-white p-4 text-sm leading-relaxed"
    >
      {isEmpty ? (
        <div className="flex h-32 items-center justify-center text-muted">
          <div className="text-center">
            <div className="text-2xl">📝</div>
            <div className="mt-2 text-xs">{emptyHint}</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <FinalsList transcripts={transcripts} startedAtMs={startedAtMs} />
          {activePartial && (
            <div className="flex gap-2 italic text-muted">
              <span className="shrink-0 select-none text-xs tabular-nums pt-0.5">
                {formatClock(startedAtMs + activePartial.atMs)}
              </span>
              <span className="flex-1">{activePartial.text}<span aria-hidden className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-muted align-middle" /></span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
