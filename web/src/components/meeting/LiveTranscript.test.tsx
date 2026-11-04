import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeetingTranscriptRow } from "@team-knowledge/shared";
import { LiveTranscript } from "./LiveTranscript";

function makeRow(id: string, text: string, startMs: number): MeetingTranscriptRow {
  return { id, text, startMs, endMs: startMs + 2000, speaker: null, createdAt: new Date().toISOString() };
}

// Fixed meeting start so offset → wall-clock is deterministic.
// 2026-06-01T06:30:00Z = 北京 14:30 (UTC+8, 与运行环境时区无关)。
const START = new Date("2026-06-01T06:30:00Z").getTime();

describe("LiveTranscript", () => {
  it("empty state hint when no finals and no partial", () => {
    render(<LiveTranscript transcripts={[]} activePartial={null} startedAtMs={START} emptyHint="自定义提示" />);
    expect(screen.getByText("自定义提示")).toBeInTheDocument();
  });

  it("renders each final with an hh:mm wall-clock prefix (start + offset)", () => {
    render(
      <LiveTranscript
        startedAtMs={START}
        transcripts={[
          makeRow("a", "你好世界", 0),          // 14:30
          makeRow("b", "我们今天讨论 V2", 60_000), // 14:31
          makeRow("c", "我刚才补充一点", 120_000), // 14:32
        ]}
        activePartial={null}
      />,
    );
    expect(screen.getByText("14:30")).toBeInTheDocument();
    expect(screen.getByText("14:31")).toBeInTheDocument();
    expect(screen.getByText("14:32")).toBeInTheDocument();
    expect(screen.getByText("你好世界")).toBeInTheDocument();
    expect(screen.getByText("我们今天讨论 V2")).toBeInTheDocument();
    expect(screen.getByText("我刚才补充一点")).toBeInTheDocument();
  });

  it("caps the live DOM to the most recent finals + shows an overflow notice", () => {
    const many = Array.from({ length: 300 }, (_, i) => makeRow(`r${i}`, `句子${i}`, i * 1000));
    render(<LiveTranscript transcripts={many} activePartial={null} startedAtMs={START} />);
    // Oldest lines are dropped from the DOM (in the summary instead); newest kept.
    expect(screen.queryByText("句子0")).not.toBeInTheDocument();
    expect(screen.getByText("句子299")).toBeInTheDocument();
    expect(screen.getByText(/仅显示最近 250 条/)).toBeInTheDocument();
  });

  it("renders the active partial below the finals in muted italic style", () => {
    const { container } = render(
      <LiveTranscript
        startedAtMs={START}
        transcripts={[makeRow("a", "已完成的句子", 0)]}  // 14:30
        activePartial={{ text: "正在说的不完整...", atMs: 90_000 }} // 14:31
      />,
    );
    expect(screen.getByText("已完成的句子")).toBeInTheDocument();
    // Use textContent so partial-with-cursor-span still matches.
    const html = container.textContent ?? "";
    expect(html).toContain("正在说的不完整...");
    expect(screen.getByText("14:30")).toBeInTheDocument();
    expect(screen.getByText("14:31")).toBeInTheDocument();
  });
});
