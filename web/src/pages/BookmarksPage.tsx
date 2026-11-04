import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ArticleWithRelations } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/relativeTime";
import { DelayedLoader } from "@/components/DelayedLoader";
import { toast } from "@/components/Toaster";
import { useT } from "@/i18n";

interface Row {
  article: ArticleWithRelations;
  createdAt: string;
}

export function BookmarksPage() {
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-row in-flight guard: a double-click would otherwise fire two
  // DELETEs, and the second 404s ("已取消收藏") and shows a spurious
  // error toast. Mirrors ProfileFeedTabs' useRowBusy (not exported, so
  // a local Set here).
  const [busy, setBusy] = useState<Set<string>>(new Set());

  async function refetch() {
    try {
      const r = await api.bookmarks.list();
      setRows(r.bookmarks);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refetch(); }, []);

  async function unbookmark(articleId: string) {
    if (busy.has(articleId)) return;
    setBusy((prev) => { const n = new Set(prev); n.add(articleId); return n; });
    try {
      await api.bookmarks.remove(articleId);
      await refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(articleId); return n; });
    }
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-red-600">{error}</div>;

  return (
    <div className="flex flex-col gap-4">
      {/* 标题「收藏」已在右区顶栏显示;这里只留数量小字(飞书:标题不重复)。 */}
      {rows.length > 0 && <p className="text-sm text-muted">{t("profile.bookmarks.count", { n: rows.length })}</p>}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-white px-8 py-10 text-center text-sm text-muted shadow-glass">
          {t("profile.bookmarks.empty")}
        </div>
      ) : (
        <ul className="rounded-xl border border-line bg-white divide-y divide-line overflow-hidden shadow-glass">
          {rows.map(({ article: a }) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-surface">
              <button
                type="button"
                onClick={() => unbookmark(a.id)}
                disabled={busy.has(a.id)}
                className="text-amber-500 disabled:opacity-50"
                aria-label={t("profile.feed.unbookmark")}
              >★</button>
              <Link to={`/d/${a.id}`} className="font-medium text-fg hover:text-primary flex-1">
                {a.title}
              </Link>
              <span className="text-xs rounded-full bg-accent-soft px-2 py-0.5 text-primary">
                {/* Role-direct docs have no folder; show role name only. */}
                {a.role.name}{a.folder ? ` / ${a.folder.name}` : ""}
              </span>
              <span className="text-xs text-muted">{a.createdBy?.displayName ?? "—"}</span>
              <span className="text-xs text-muted">{fmtDate(a.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
