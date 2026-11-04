import type { AnalyticsRankings } from "@team-knowledge/shared";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";

// Knowledge-base health, derived from the role-skill status distribution that
// the analytics endpoint already returns — no extra query. Surfaces what needs
// attention (failed / stale generations) at a glance.
export function KbHealthCard({ skillStatus }: { skillStatus: AnalyticsRankings["skillStatus"] }) {
  const t = useT();
  const byStatus = (s: string) => skillStatus.find((x) => x.status === s)?.count ?? 0;
  const failed = byStatus("failed");
  const stale = byStatus("stale");
  const healthy = failed === 0 && stale === 0;

  const rows: { label: string; value: number; tone: string }[] = [
    { label: t("dashboard.health.failed"), value: failed, tone: failed > 0 ? "text-rose-600" : "text-muted" },
    { label: t("dashboard.health.stale"), value: stale, tone: stale > 0 ? "text-amber-600" : "text-muted" },
    { label: t("dashboard.health.generating"), value: byStatus("generating"), tone: "text-primary" },
    { label: t("dashboard.health.empty"), value: byStatus("empty"), tone: "text-muted" },
    { label: t("dashboard.health.fresh"), value: byStatus("fresh"), tone: "text-emerald-600" },
  ];

  return (
    <section className="flex flex-col rounded-xl border border-line bg-white shadow-glass">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">{t("dashboard.health.title")}</div>
      <div className="p-4">
        <div className={cn("mb-3 text-sm", healthy ? "text-emerald-600" : "text-amber-600")}>
          {healthy ? t("dashboard.health.ok") : t("dashboard.health.attention")}
        </div>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between text-sm">
              <span className="text-muted">{r.label}</span>
              <span className={cn("font-medium tabular-nums", r.tone)}>{r.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
