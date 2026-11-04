import type { AnalyticsRankings } from "@team-knowledge/shared";
import { ACTIVITY_LABEL } from "@/components/activity/ActivityFeed";
import { cn } from "@/lib/cn";

export interface RankItem {
  id: string;
  label: string;
  value: number;
  /** Optional trailing hint (e.g. status label). */
  hint?: string;
  /** Optional hover 明细(原生 title),如热门文档的浏览/赞/评/藏构成、贡献者的操作构成。 */
  tooltip?: string;
  onClick?: () => void;
}

const SKILL_STATUS_LABEL: Record<string, string> = {
  empty: "未生成", stale: "待更新", generating: "生成中", fresh: "最新", failed: "失败",
};

// Pure-CSS horizontal bar ranking — fully renderable in jsdom (no SVG) and
// trivially clickable for drill-down.
export function RankingBars({ title, items, color = "#3370FF", note }: { title: string; items: RankItem[]; color?: string; note?: string }) {
  const max = items.reduce((m, it) => Math.max(m, it.value), 0) || 1;
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {note && <span className="text-[11px] text-muted/70">{note}</span>}
      </div>
      {items.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-xs text-muted">暂无数据</div>
      ) : (
        <ol className="space-y-2">
          {items.map((it, i) => {
            const Tag = it.onClick ? "button" : "div";
            return (
              <li key={it.id}>
                <Tag
                  type={it.onClick ? "button" : undefined}
                  onClick={it.onClick}
                  title={it.tooltip}
                  className={cn(
                    "group flex w-full items-center gap-2 text-left",
                    it.onClick && "cursor-pointer",
                  )}
                >
                  <span className="w-4 shrink-0 text-xs tabular-nums text-muted/70">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("truncate text-sm", it.onClick && "group-hover:text-primary")}>{it.label}</span>
                      {it.hint && <span className="shrink-0 text-[11px] text-muted">{it.hint}</span>}
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{it.value}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                      <div className="h-full rounded-full" style={{ width: `${(it.value / max) * 100}%`, backgroundColor: color }} />
                    </div>
                  </div>
                </Tag>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function RankingsSection({
  rankings,
  onDoc,
  onRole,
  onUser,
}: {
  rankings: AnalyticsRankings;
  onDoc?: (articleId: string) => void;
  onRole?: (roleId: string) => void;
  onUser?: (userId: string) => void;
}) {
  return (
    <section className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4">
      <RankingBars
        title="热门文档"
        note="窗口内综合热度"
        color="#3370FF"
        items={rankings.hotDocs.map((d) => ({
          id: d.articleId, label: d.title, value: d.score,
          tooltip: `浏览 ${d.viewers} · 点赞 ${d.likes} · 评论 ${d.comments} · 收藏 ${d.bookmarks}`,
          onClick: onDoc ? () => onDoc(d.articleId) : undefined,
        }))}
      />
      <RankingBars
        title="活跃贡献者"
        note="加权 · 近期优先"
        color="#00B42A"
        items={rankings.topContributors.map((c) => ({
          id: c.userId, label: c.userName, value: c.contribution,
          tooltip: [
            ...c.breakdown.map((b) => `${ACTIVITY_LABEL[b.type]} ×${b.count}`),
            ...(c.received > 0 ? [`被认可 +${c.received}`] : []),
          ].join(" · ") || undefined,
          onClick: onUser ? () => onUser(c.userId) : undefined,
        }))}
      />
      <RankingBars
        title="各角色文档数"
        color="#FF7D00"
        items={rankings.docsByRole.map((r) => ({
          id: r.roleId, label: r.roleName, value: r.count,
          onClick: onRole ? () => onRole(r.roleId) : undefined,
        }))}
      />
      <RankingBars
        title="角色 Skill 状态"
        color="#7B61FF"
        items={rankings.skillStatus.map((s) => ({
          id: s.status, label: SKILL_STATUS_LABEL[s.status] ?? s.status, value: s.count,
        }))}
      />
    </section>
  );
}
