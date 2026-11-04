import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FeedArticleRow, PublicUserProfileResponse } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { fmtDate } from "@/lib/relativeTime";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/dashboard/UserActivityDrawer";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { DelayedLoader } from "@/components/DelayedLoader";

type TabKey = "articles" | "activity";
const TABS: { key: TabKey; label: string }[] = [
  { key: "articles", label: "发布的文档" },
  { key: "activity", label: "动态" },
];

/**
 * Public per-user profile at `/u/:userId` — viewable by any logged-in user.
 * Identity card (avatar + role tags + join date) mirrors ProfilePage's house
 * style, with two tabs: 发布的文档 (the target's non-draft docs, ACL-filtered
 * to the viewer) and 动态 (the target's public contribution feed, ACL-filtered).
 * Email is never shown. 404s render a friendly "用户不存在" state.
 */
export function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const me = useAuth((s) => s.user);
  const [profile, setProfile] = useState<PublicUserProfileResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("articles");

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setProfile(null);
    setNotFound(false);
    setError(null);
    setTab("articles");
    api.users
      .profile(userId)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError((err as Error).message);
      });
    return () => { cancelled = true; };
  }, [userId]);

  if (notFound) {
    return (
      <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
        用户不存在
      </div>
    );
  }
  if (error) return <div className="text-rose-600 text-sm">⚠ {error}</div>;
  if (!profile || !userId) return <DelayedLoader />;

  const isMe = me?.id === profile.id;

  return (
    <div className="flex flex-col gap-6">
      {/* Identity card — avatar + name + tags + join date. No email. */}
      <section className="rounded-xl border border-line bg-white p-5 shadow-glass">
        <div className="flex items-center gap-4">
          <Avatar name={profile.displayName} url={profile.avatarUrl} large />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-lg font-semibold text-fg">{profile.displayName}</p>
              {profile.isAdmin && (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-primary">管理员</span>
              )}
              {profile.roles.map((r) => (
                <span key={r} className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{r}</span>
              ))}
            </div>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted">
              <span>注册 {fmtDate(profile.createdAt)}</span>
              <span>发布 {profile.publishedCount} 篇</span>
            </div>
            {isMe && <p className="mt-1 text-xs text-muted/70">这是你的公开主页</p>}
          </div>
        </div>
      </section>

      {/* Tabs — 发布的文档 / 动态. */}
      <section className="rounded-xl border border-line bg-white shadow-glass">
        <div className="flex border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex-1 px-4 py-3 text-sm transition",
                tab === t.key
                  ? "border-b-2 border-primary font-semibold text-primary"
                  : "text-muted hover:text-primary",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div>
          {tab === "articles" && <ArticlesTab userId={userId} />}
          {tab === "activity" && (
            <ActivityFeed
              fetchPage={(p) => api.users.activity(userId, p)}
              resetKey={userId}
              hideUser
              emptyHint="暂无公开动态。"
            />
          )}
        </div>
      </section>
    </div>
  );
}

// 发布的文档 — the target's non-draft docs the viewer can see, each linking
// to /d/:id. Row style mirrors the role/folder feed lists (RoleBadge +
// title + meta line).
function ArticlesTab({ userId }: { userId: string }) {
  const [rows, setRows] = useState<FeedArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.users
      .articles(userId)
      .then((r) => { if (!cancelled) setRows(r.articles); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) return <div className="px-4 py-8"><DelayedLoader /></div>;
  if (error) return <div className="px-4 py-6 text-sm text-rose-600">{error}</div>;
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-muted">还没有发布过文档。</div>;
  }
  return (
    <ul className="divide-y divide-line/60">
      {rows.map((a) => (
        <li key={a.id}>
          <Link
            to={`/d/${a.id}`}
            className="group flex items-center gap-3 px-4 py-3 transition hover:bg-blue-50/60"
          >
            <RoleBadge name={a.roleName} color={a.roleColor} variant="soft" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg group-hover:text-primary transition">
                {a.title || "（未命名）"}
              </div>
              <div className="mt-0.5 flex items-center gap-4 truncate text-xs text-muted">
                {a.folderName && <span className="truncate">{a.folderName}</span>}
                <span className="truncate">{fmtDate(a.updatedAt)}</span>
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
