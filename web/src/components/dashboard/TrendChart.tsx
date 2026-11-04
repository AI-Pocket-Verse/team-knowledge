import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsTrends } from "@team-knowledge/shared";
import { cn } from "@/lib/cn";
import { getAssistantName } from "@/lib/assistantName";

// One toggleable line per metric. activeUsers is included so admins can
// correlate daily activity with content/interaction volume.
type SeriesKey = keyof Omit<AnalyticsTrends, "dayLabels">;
const SERIES: { key: SeriesKey; name: string; color: string }[] = [
  { key: "docCreate", name: "新增文档", color: "#3370FF" },
  { key: "docEdit", name: "编辑文档", color: "#00B42A" },
  { key: "comment", name: "评论", color: "#FF7D00" },
  { key: "like", name: "点赞", color: "#F53F3F" },
  { key: "bookmark", name: "收藏", color: "#7B61FF" },
  { key: "upload", name: "上传", color: "#0FC6C2" },
  { key: "chat", get name() { return `${getAssistantName()} 提问`; }, color: "#165DFF" },
  { key: "meeting", name: "会议", color: "#D91AD9" },
  { key: "activeUsers", name: "活跃用户", color: "#86909C" },
];

export function TrendChart({ trends }: { trends: AnalyticsTrends }) {
  // Series hidden by the user (click a chip to toggle). Default: a focused
  // subset on so the chart isn't a spaghetti of 9 lines.
  const [hidden, setHidden] = useState<Set<SeriesKey>>(
    () => new Set<SeriesKey>(["docEdit", "upload", "meeting", "bookmark"]),
  );
  const toggle = (k: SeriesKey) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const data = trends.dayLabels.map((label, i) => {
    const row: Record<string, number | string> = { label };
    for (const s of SERIES) row[s.key] = trends[s.key][i] ?? 0;
    return row;
  });
  const hasData = SERIES.some((s) => trends[s.key].some((n) => n > 0));

  return (
    <section className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">内容与互动趋势</h2>
        <div className="flex flex-wrap gap-1.5">
          {SERIES.map((s) => {
            const on = !hidden.has(s.key);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggle(s.key)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition",
                  on ? "border-transparent text-fg" : "border-line text-muted/60",
                )}
                style={on ? { backgroundColor: `${s.color}1a` } : undefined}
                aria-pressed={on}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: on ? s.color : "#dee0e3" }} />
                {s.name}
              </button>
            );
          })}
        </div>
      </div>

      {hasData ? (
        <div className="h-64 w-full">
          {/* initialDimension avoids recharts' "width(-1) height(-1)" warning +
              blank first paint: it renders at this size, then the ResizeObserver
              corrects to the real container size. */}
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 256 }}>
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dee0e3" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#86909c" }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#86909c" }} width={36} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #dee0e3" }} />
              {SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center text-sm text-muted">暂无数据</div>
      )}
    </section>
  );
}
