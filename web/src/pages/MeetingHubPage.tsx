import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingHubResponse, MeetingSessionRow } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { DelayedLoader } from "@/components/DelayedLoader";
import { usePageChrome } from "@/stores/pageChrome";
import { beijingParts } from "@/lib/tz";

//助手会议 hub — every logged-in user lands here from the nav tab.
// Shows currently-running meetings (anyone can click in to watch
// read-only) + recent ended meetings. Any logged-in user can start a
// meeting via "新会议"; private ones are flagged with a 🔒 badge.
// The hub list is already visibility-filtered server-side.
export function MeetingHubPage() {
  const [data, setData] = useState<MeetingHubResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.meeting.hub();
        if (alive) setData(r);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  // 页面标题「会议」只在右区顶栏出现(飞书式:标题不重复);「新会议」登记到顶栏右侧。
  usePageChrome({
    rightActions: (
      <Link
        to="/meeting/new"
        className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg shadow-glass transition hover:bg-primary/90 active:scale-95"
      >
        <span aria-hidden className="text-base leading-none">＋</span>
        新会议
      </Link>
    ),
  });

  if (error) return <div className="text-rose-600">{error}</div>;
  if (!data) return <DelayedLoader />;

  return (
    <div className="flex flex-col gap-6">
      {/* 正在进行 section. Only renders when there's at least one
          active meeting — keeps the hub tidy on most loads. */}
      {data.active.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted">正在进行 ({data.active.length})</h2>
          <ul className="flex flex-col gap-2">
            {data.active.map((m) => (
              <li key={m.id}>
                <ActiveMeetingCard meeting={m} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted">往期会议</h2>
        {data.recent.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface px-8 py-10 text-center text-sm text-muted">
            还没有任何会议记录。点击右上「新会议」开始第一场。
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.recent.map((m) => (
              <li key={m.id}>
                <RecentMeetingCard meeting={m} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ActiveMeetingCard({ meeting }: { meeting: MeetingSessionRow }) {
  return (
    <Link
      to={`/meeting/${meeting.id}`}
      className="block rounded-xl border border-line bg-white px-4 py-3 shadow-glass transition hover:shadow-glassLg"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-semibold text-rose-600">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
              LIVE
            </span>
            <span className="truncate">{meeting.title}</span>
            {meeting.visibility === "private" && <PrivateBadge />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>主持人：{meeting.hostName}</span>
            <span>开始于 {formatTime(meeting.createdAt)}</span>
            <span>关联：{meeting.allowedRoles.map((r) => r.name).join(" / ") || "（无）"}</span>
          </div>
        </div>
        <span className="shrink-0 text-sm text-primary">进入会议室 →</span>
      </div>
    </Link>
  );
}

function RecentMeetingCard({ meeting }: { meeting: MeetingSessionRow }) {
  const minutes = meeting.endedAt
    ? Math.max(1, Math.round((new Date(meeting.endedAt).getTime() - new Date(meeting.createdAt).getTime()) / 60_000))
    : null;
  return (
    <Link
      to={`/meeting/${meeting.id}`}
      className="block rounded-xl border border-line bg-surface px-4 py-3 transition hover:bg-white hover:shadow-glass"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <span className="truncate">{meeting.title}</span>
            {meeting.visibility === "private" && <PrivateBadge />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>{formatDate(meeting.endedAt ?? meeting.createdAt)}</span>
            {minutes !== null && <span>{minutes} 分钟</span>}
            <span>主持人：{meeting.hostName}</span>
            <span>关联：{meeting.allowedRoles.map((r) => r.name).join(" / ") || "（无）"}</span>
          </div>
        </div>
        <span className="shrink-0 text-sm text-muted">查看 →</span>
      </div>
    </Link>
  );
}

function PrivateBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted">
      <span aria-hidden>🔒</span>私密
    </span>
  );
}

function formatTime(iso: string): string {
  const { hour, minute } = beijingParts(new Date(iso));
  return `${hour}:${minute}`;
}

function formatDate(iso: string): string {
  const { year, month, day } = beijingParts(new Date(iso));
  return `${year}-${month}-${day}`;
}
