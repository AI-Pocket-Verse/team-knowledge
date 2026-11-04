import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fmtDate, fmtRelativeTime } from "@/lib/relativeTime";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { useT } from "@/i18n";

// Minimal shape to open a per-user activity drawer. The dashboard passes a full
// AdminDashboardUserRow (rich header + stats); lighter callers (e.g. the weekly
// report) pass just { id, displayName } and the header degrades to name + the
// activity feed. The feed is admin-only (api.admin.activity), so this drawer is
// for admin surfaces only.
export interface UserActivityTarget {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  email?: string | null;
  isAdmin?: boolean;
  isActive?: boolean;
  roles?: string[];
  createdAt?: string;
  opsToday?: number;
  ops7d?: number;
  lastSeenAt?: string | null;
}

export function Avatar({ name, url, large }: { name: string; url: string | null; large?: boolean }) {
  const size = large ? "h-10 w-10 text-sm" : "h-7 w-7 text-xs";
  if (url) return <img src={url} alt="" className={cn("shrink-0 rounded-full object-cover", size)} />;
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-medium text-primary", size)}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", className)}>{children}</span>;
}

function Stat({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="bg-white px-2 py-3">
      <div className="text-lg font-semibold tabular-nums">{text ?? (value ?? 0)}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

// Slide-out drawer: user identity + per-user activity feed. Shared by the
// dashboard and the weekly report so the "click a user" jump is identical.
export function UserActivityDrawer({ user, onClose }: { user: UserActivityTarget; onClose: () => void }) {
  const t = useT();
  const hasStats = user.opsToday !== undefined || user.ops7d !== undefined || user.lastSeenAt !== undefined;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-hidden border-l border-line bg-white shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={user.displayName} url={user.avatarUrl ?? null} large />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-base font-semibold">{user.displayName}</span>
                {user.isAdmin && <Tag className="bg-accent-soft text-primary">{t("dashboard.users.admin")}</Tag>}
                {user.isActive === false && <Tag className="bg-rose-100 text-rose-700">{t("dashboard.users.disabled")}</Tag>}
                {user.roles?.map((r) => (
                  <Tag key={r} className="bg-surface text-muted">{r}</Tag>
                ))}
              </div>
              {user.email && <div className="truncate text-xs text-muted/70">{user.email}</div>}
              {user.createdAt && (
                <div className="mt-0.5 text-xs text-muted">
                  {user.roles && user.roles.length === 0 && t("dashboard.drawer.noRole")}{t("dashboard.drawer.joined", { date: fmtDate(user.createdAt) })}
                </div>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1 text-muted transition hover:bg-surface hover:text-fg" aria-label={t("dashboard.drawer.close")}>
            ✕
          </button>
        </div>

        {hasStats && (
          <div className="grid grid-cols-3 gap-px border-b border-line bg-line/50 text-center">
            <Stat label={t("dashboard.drawer.opsToday")} value={user.opsToday} />
            <Stat label={t("dashboard.drawer.ops7d")} value={user.ops7d} />
            <Stat label={t("dashboard.drawer.lastSeen")} text={user.lastSeenAt ? fmtRelativeTime(user.lastSeenAt) : "—"} />
          </div>
        )}

        <div className="px-5 py-2 text-xs font-semibold text-muted">{t("dashboard.drawer.activity")}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ActivityFeed fetchPage={(p) => api.admin.activity({ userId: user.id, page: p })} resetKey={user.id} hideUser />
        </div>
      </div>
    </div>
  );
}
