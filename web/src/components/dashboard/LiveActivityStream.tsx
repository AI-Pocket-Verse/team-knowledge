import { useState } from "react";
import type { AdminActivityType, AdminDashboardActivity } from "@team-knowledge/shared";
import { ACTIVITY_LABEL } from "@/components/activity/ActivityFeed";
import { fmtRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/cn";

// 「噪声」动作:高频、低信息量,开启「仅看重要动态」时隐藏,避免刷屏淹没
// 建文档/会议/上传等高价值动态。
const NOISE_TYPES = new Set<AdminActivityType>(["like", "comment_like", "bookmark"]);

// Live event feed for the dashboard. Presentational: the page owns the list
// (seeded from /admin/activity, prepended from the SSE stream). A pulsing dot
// signals the live connection. 「仅看重要动态」在本组件内做客户端过滤。
export function LiveActivityStream({ items }: { items: AdminDashboardActivity[] }) {
  const [importantOnly, setImportantOnly] = useState(false);
  const shown = importantOnly ? items.filter((r) => !NOISE_TYPES.has(r.type)) : items;
  return (
    <section className="flex flex-col rounded-xl border border-line bg-white shadow-glass">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
        实时动态
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <button
          type="button"
          onClick={() => setImportantOnly((v) => !v)}
          title="隐藏点赞/收藏等高频动态,只看建文档、会议、上传等"
          className={cn(
            "ml-auto rounded-full border px-2.5 py-0.5 text-xs font-normal transition",
            importantOnly
              ? "border-primary bg-accent-soft text-primary"
              : "border-line text-muted hover:bg-surface",
          )}
        >
          仅看重要动态
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted">
          {importantOnly && items.length > 0 ? "暂无重要动态" : "等待最新动态…"}
        </div>
      ) : (
        <ul className="max-h-96 divide-y divide-line/60 overflow-y-auto">
          {shown.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-4 py-2.5 text-sm transition hover:bg-surface">
              <span className="shrink-0 font-medium">{r.userName}</span>
              <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{ACTIVITY_LABEL[r.type]}</span>
              {r.title && <span className="min-w-0 truncate text-muted">{r.title}</span>}
              <span className="ml-auto shrink-0 text-xs text-muted/70 tabular-nums">{fmtRelativeTime(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
