import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AdminAnalyticsResponse, AdminDashboardActivity, AdminDashboardResponse, AdminDashboardUserRow } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { CompositionPies } from "@/components/dashboard/CompositionPies";
import { RankingsSection } from "@/components/dashboard/RankingBars";
import { LiveActivityStream } from "@/components/dashboard/LiveActivityStream";
import { KbHealthCard } from "@/components/dashboard/KbHealthCard";
import { useDashboardStream } from "@/components/dashboard/useDashboardStream";
import { Reveal } from "@/components/dashboard/Reveal";
import { UserActivityDrawer, Avatar, Tag } from "@/components/dashboard/UserActivityDrawer";
import { fmtDate, fmtRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/cn";
import { getAssistantName } from "@/lib/assistantName";
import { useT } from "@/i18n";

const WINDOWS = [7, 14, 30] as const;

export function DashboardPage() {
  const navigate = useNavigate();
  const t = useT();
  // Aggregate sections render for everyone; the per-user table + per-user
  // activity drawer are admin-only ("聚合公开、个人明细仅管理员"). The backend
  // enforces the same split (data.users is [] for non-admins).
  const isAdmin = useIsAdmin();
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<AdminDashboardResponse | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminDashboardUserRow | null>(null);
  const [liveItems, setLiveItems] = useState<AdminDashboardActivity[]>([]);

  // Latest window for the SSE-driven refetch (which lives outside the days effect).
  const daysRef = useRef(days);
  daysRef.current = days;
  // Throttle SSE "tick" → chart refetch: coalesce a burst of ticks into one
  // refetch every 2.5s.
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setAnalytics(null);
    setLiveItems([]);
    setError(null);
    api.admin
      .dashboard(days)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    // Charts are best-effort: a failure here shouldn't blank the whole page —
    // the overview error already surfaces above.
    api.admin
      .analytics(days)
      .then((r) => { if (alive) setAnalytics(r); })
      .catch(() => { /* ignore — charts simply stay hidden */ });
    // Seed the live feed with the most recent page; the SSE stream prepends
    // newer events on top of this.
    api.admin
      .activity({ page: 1 })
      .then((r) => { if (alive) setLiveItems(r.items); })
      .catch(() => { /* live feed simply starts empty */ });
    return () => { alive = false; };
  }, [days]);

  // Live stream: prepend pushed events; throttled refetch of the aggregate
  // charts on each tick. Mounted once — callbacks read the current window via a ref.
  useDashboardStream({
    onActivity: (items) =>
      setLiveItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = items.filter((it) => !seen.has(it.id));
        if (fresh.length === 0) return prev;
        // Poller pushes ascending by time; reverse so the newest sits on top.
        return [...fresh.reverse(), ...prev].slice(0, 50);
      }),
    onTick: () => {
      if (tickTimer.current) return; // a refetch is already scheduled
      tickTimer.current = setTimeout(() => {
        tickTimer.current = null;
        const d = daysRef.current;
        // Ignore a late response if the admin switched the window meanwhile —
        // the days effect already cleared + refetched for the new window.
        api.admin.analytics(d).then((r) => { if (daysRef.current === d) setAnalytics(r); }).catch(() => {});
        api.admin.dashboard(d).then((r) => { if (daysRef.current === d) setData(r); }).catch(() => {});
      }, 2500);
    },
  });

  // Clear any pending throttled refetch on unmount.
  useEffect(() => () => { if (tickTimer.current) clearTimeout(tickTimer.current); }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("dashboard.title")}</h1>
        <div className="inline-flex overflow-hidden rounded-lg border border-line text-sm">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={cn(
                "px-3 py-1.5 transition",
                days === w ? "bg-primary text-primary-fg" : "bg-white text-muted hover:bg-surface",
              )}
            >
              {t("dashboard.window", { n: w })}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="text-rose-600">{error}</div>}
      {!error && !data && <DelayedLoader />}

      {data && (
        <>
          <Reveal delay={0}>
            <OverviewCards o={data.overview} />
          </Reveal>
          {analytics && (
            <>
              <Reveal delay={60}>
                <TrendChart trends={analytics.trends} />
              </Reveal>
              <Reveal delay={120}>
                <CompositionPies composition={analytics.composition} />
              </Reveal>
              <Reveal delay={180}>
                <RankingsSection
                  rankings={analytics.rankings}
                  onDoc={(id) => navigate(`/d/${id}`)}
                  onRole={(id) => navigate(`/r/${id}`)}
                  // Clicking a ranked user opens the per-user activity drawer —
                  // admin only. Non-admins see the ranking but it isn't clickable
                  // (and data.users is empty for them anyway).
                  onUser={isAdmin ? (id) => {
                    const u = data.users.find((r) => r.id === id);
                    if (u) setSelected(u);
                  } : undefined}
                />
              </Reveal>
            </>
          )}
          <Reveal delay={240}>
            <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <LiveActivityStream items={liveItems} />
              </div>
              {analytics && <KbHealthCard skillStatus={analytics.rankings.skillStatus} />}
            </section>
          </Reveal>
          {isAdmin && (
            <Reveal delay={300}>
              <UsersTable users={data.users} dayLabels={data.dayLabels} onSelect={setSelected} />
            </Reveal>
          )}
        </>
      )}

      {selected && <UserActivityDrawer user={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function OverviewCards({ o }: { o: AdminDashboardResponse["overview"] }) {
  const t = useT();
  const cards: { label: string; value: number; hint?: string }[] = [
    { label: t("dashboard.card.totalUsers"), value: o.totalUsers, hint: t("dashboard.card.totalUsers.hint", { n: o.newUsers7d }) },
    { label: t("dashboard.card.activeToday"), value: o.activeToday, hint: t("dashboard.card.activeToday.hint", { n: o.active7d }) },
    { label: t("dashboard.card.docs"), value: o.docs },
    { label: t("dashboard.card.comments"), value: o.comments },
    { label: t("dashboard.card.meetings"), value: o.meetings },
    { label: t("dashboard.card.chat", { name: getAssistantName() }), value: o.chatMessages },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-line bg-white p-4 shadow-glass">
          <div className="text-xs text-muted">{c.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{c.value.toLocaleString()}</div>
          {c.hint && <div className="mt-1 text-[11px] text-muted/70">{c.hint}</div>}
        </div>
      ))}
    </section>
  );
}

function UsersTable({
  users, dayLabels, onSelect,
}: {
  users: AdminDashboardUserRow[];
  dayLabels: string[];
  onSelect: (u: AdminDashboardUserRow) => void;
}) {
  const t = useT();
  return (
    <section className="rounded-xl border border-line bg-white shadow-glass">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">
        {t("dashboard.users.title")} <span className="text-muted">({users.length})</span>
        <span className="ml-2 text-xs font-normal text-muted/70">{t("dashboard.users.hint")}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">{t("dashboard.users.colUser")}</th>
              <th className="px-4 py-2 font-medium">{t("dashboard.users.colRole")}</th>
              <th className="px-4 py-2 font-medium">{t("dashboard.users.colJoined")}</th>
              <th className="px-4 py-2 font-medium">{t("dashboard.users.colLastSeen")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("dashboard.users.colToday")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("dashboard.users.col7d")}</th>
              <th className="px-4 py-2 font-medium">{t("dashboard.users.colDaily")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                onClick={() => onSelect(u)}
                className="cursor-pointer border-b border-line/60 transition hover:bg-surface last:border-0"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Avatar name={u.displayName} url={u.avatarUrl} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{u.displayName}</span>
                        {u.isAdmin && <Tag className="bg-accent-soft text-primary">{t("dashboard.users.admin")}</Tag>}
                        {!u.isActive && <Tag className="bg-rose-100 text-rose-700">{t("dashboard.users.disabled")}</Tag>}
                      </div>
                      {u.email && <div className="truncate text-[11px] text-muted/70">{u.email}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted">{u.roles.length ? u.roles.join(" / ") : "—"}</td>
                <td className="px-4 py-2.5 text-muted tabular-nums">{fmtDate(u.createdAt)}</td>
                <td className="px-4 py-2.5 text-muted">{fmtRelativeTime(u.lastSeenAt)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{u.opsToday}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{u.ops7d}</td>
                <td className="px-4 py-2.5">
                  <Heat daily={u.daily} dayLabels={dayLabels} />
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">{t("dashboard.users.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Heat({ daily, dayLabels }: { daily: number[]; dayLabels: string[] }) {
  const t = useT();
  return (
    <div className="flex items-end gap-0.5">
      {daily.map((n, i) => (
        <span key={i} title={t("dashboard.heat.title", { label: dayLabels[i] ?? "", n })} className={cn("h-4 w-2.5 rounded-sm", heatClass(n))} />
      ))}
    </div>
  );
}

function heatClass(n: number): string {
  if (n <= 0) return "bg-surface";
  if (n <= 2) return "bg-blue-200";
  if (n <= 5) return "bg-blue-400";
  if (n <= 10) return "bg-blue-500";
  return "bg-blue-700";
}

