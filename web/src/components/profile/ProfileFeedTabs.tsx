import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ArticleWithRelations, CollaborationRow, FeedArticleRow } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { CollaboratorsDialog } from "./CollaboratorsDialog";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/cn";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT } from "@/i18n";

type TabKey = "activity" | "articles" | "collaborations" | "bookmarks" | "likes";
const TABS: { key: TabKey; label: string }[] = [
  { key: "activity",       get label() { return tr("profile.tab.activity"); } },
  { key: "articles",       get label() { return tr("profile.tab.articles"); } },
  { key: "collaborations", get label() { return tr("profile.tab.collaborations"); } },
  { key: "bookmarks",      get label() { return tr("profile.tab.bookmarks"); } },
  { key: "likes",          get label() { return tr("profile.tab.likes"); } },
];

interface FeedRowProps {
  row: FeedArticleRow;
  rightSlot?: React.ReactNode;
}

function FeedRow({ row, rightSlot }: FeedRowProps) {
  const t = useT();
  return (
    // Hover paints a lavender row tint that previews "this row is the
    // primary thing to click" — matches the sub.png table feel. The
    // hairline `border-b` doubles as the row divider, dropped on the
    // last row via `last:border-0`.
    <div className="group flex items-center justify-between gap-3 border-b border-line/60 px-4 py-3 last:border-0 transition hover:bg-blue-50/60">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to={`/d/${row.id}`}
            className="truncate text-sm font-medium hover:text-primary"
          >
            {row.title || t("profile.feed.untitled")}
          </Link>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          <RoleBadge name={row.roleName} color={row.roleColor} variant="soft" />
          <span className="truncate">{row.folderName}</span>
          <span>{formatTimestamp(row.updatedAt)}</span>
        </div>
      </div>
      {rightSlot && <div className="shrink-0">{rightSlot}</div>}
    </div>
  );
}

// Square 28x28 icon button used by every per-row action in the
// profile tabs. Kept here (not extracted to ui/) because it currently
// has no other consumer; promotion can wait until a second surface
// needs the same affordance.
function IconButton({
  title,
  onClick,
  disabled,
  variant = "default",
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  /// "default" hovers to violet. "danger" hovers to rose — used for
  /// delete-style actions so the destructive intent reads at a glance.
  variant?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        "h-7 w-7 inline-flex items-center justify-center rounded-lg text-muted transition disabled:opacity-40",
        variant === "danger"
          ? "hover:bg-rose-50 hover:text-rose-600"
          : "hover:bg-blue-100 hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

// Inline SVG icons — small enough that pulling lucide-react adds
// more dependency weight than the literal markup. Width/height/viewBox
// match the preview mock.
const ICON_EDIT = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);
const ICON_USERS = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const ICON_TRASH = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
  </svg>
);
const ICON_BOOKMARK_OFF = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
const ICON_HEART_OFF = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);

/**
 * Bottom block of the personal page: four tabs (动态 / 文档 / 收藏 /
 * 点赞), each loading its own data on demand (only when the tab is
 * activated, so the page isn't N+1 API calls on mount).
 *
 * Each row's destructive actions (archive / delete / unbookmark /
 * unlike) are gated on a per-row "busy" id set so a double-click
 * during an in-flight request can't fire the same mutation twice.
 */
export function ProfileFeedTabs() {
  const [tab, setTab] = useState<TabKey>("activity");
  return (
    <section className="rounded-xl border border-line bg-white shadow-glass">
      <div className="flex border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              "flex-1 px-4 py-3 text-sm transition " +
              (tab === t.key
                ? "border-b-2 border-primary font-semibold text-primary"
                : "text-muted hover:text-primary")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>
        {tab === "activity" && <ActivityTab />}
        {tab === "articles" && <ArticlesTab />}
        {tab === "collaborations" && <CollaborationsTab />}
        {tab === "bookmarks" && <BookmarksTab />}
        {tab === "likes" && <LikesTab />}
      </div>
    </section>
  );
}

// The caller's own recent dynamics — same aggregation + UI the admin
// dashboard uses per user, but self-scoped via GET /api/me/activity.
// Paginated 10/page; `hideUser` drops the redundant name (it's always me).
function ActivityTab() {
  const t = useT();
  return (
    <ActivityFeed
      fetchPage={(p) => api.myActivity({ page: p })}
      hideUser
      emptyHint={t("profile.feed.activityEmpty", { name: getAssistantName() })}
    />
  );
}

// Helper hook: returns a per-id busy state and a runner that
// flips the id into the set for the duration of the async action.
// Centralised so all three tabs share the same double-click guard
// pattern.
function useRowBusy() {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const isBusy = (id: string) => busy.has(id);
  async function run<T>(id: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.has(id)) return undefined;
    setBusy((prev) => { const n = new Set(prev); n.add(id); return n; });
    try {
      return await fn();
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }
  return { isBusy, run };
}

function ArticlesTab() {
  const t = useT();
  const [rows, setRows] = useState<FeedArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { isBusy, run } = useRowBusy();
  const nav = useNavigate();
  // Which article's collaborator dialog is currently open (null = none).
  // Stored at the tab level rather than per-row so we don't re-mount
  // the dialog when other rows re-render after an archive/delete.
  const [collabArticle, setCollabArticle] = useState<FeedArticleRow | null>(null);

  // Cancelled flag protects against the "setState on unmounted
  // component" warning when the user switches tabs mid-flight.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.myArticles();
        if (cancelled) return;
        setRows(r.articles);
      } catch (err) {
        if (cancelled) return;
        toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function refresh() {
    try {
      const r = await api.myArticles();
      setRows(r.articles);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(id: string) {
    const ok = await dialog.confirm(t("profile.feed.irreversible"), {
      title: t("profile.feed.confirmDelete"),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    await run(id, async () => {
      try {
        await api.articles.delete(id);
        toast.success(t("profile.feed.deleted"));
        await refresh();
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  if (loading) return <div className="px-4 py-8 text-sm text-muted">{t("common.loading")}</div>;
  if (rows.length === 0) return <div className="px-4 py-8 text-center text-sm text-muted">{t("profile.feed.noArticles")}</div>;
  return (
    <div>
      {rows.map((row) => {
        const rowBusy = isBusy(row.id);
        return (
          <FeedRow
            key={row.id}
            row={row}
            rightSlot={
              <div className="flex gap-0.5">
                {row.permissions.canEdit && (
                  <IconButton
                    title={t("profile.feed.open")}
                    onClick={() => nav(`/d/${row.id}`)}
                  >
                    {ICON_EDIT}
                  </IconButton>
                )}
                {/* Per-article editor ACL management — only author + admin
                    see this button (canManageEditors is the gate, NOT
                    canEdit, since collaborators have canEdit but can't
                    re-grant). */}
                {row.permissions.canManageEditors && (
                  <IconButton title={t("profile.feed.collaborators")} onClick={() => setCollabArticle(row)}>
                    {ICON_USERS}
                  </IconButton>
                )}
                {row.permissions.canEdit && (
                  <IconButton title={t("common.delete")} variant="danger" disabled={rowBusy} onClick={() => remove(row.id)}>
                    {ICON_TRASH}
                  </IconButton>
                )}
              </div>
            }
          />
        );
      })}
      {collabArticle && (
        <CollaboratorsDialog
          open
          onOpenChange={(open) => { if (!open) setCollabArticle(null); }}
          articleId={collabArticle.id}
          articleTitle={collabArticle.title || t("profile.feed.untitled")}
        />
      )}
    </div>
  );
}

function CollaborationsTab() {
  const t = useT();
  const [rows, setRows] = useState<CollaborationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.myCollaborations();
        if (cancelled) return;
        setRows(r.collaborations);
      } catch (err) {
        if (cancelled) return;
        toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="px-4 py-8 text-sm text-muted">{t("common.loading")}</div>;
  if (rows.length === 0) {
    // Friendly empty state — "you don't have any collaborations" is
    // genuinely uncommon (the author has to grant you) so we briefly
    // explain how grants happen.
    return (
      <div className="px-4 py-8 text-center text-sm text-muted">
        {t("profile.feed.noCollabs")}
      </div>
    );
  }
  return (
    <div>
      {rows.map(({ article: a }) => (
        <FeedRow
          key={a.id}
          row={{
            id: a.id, title: a.title,
            folderId: a.folderId, folderName: a.folderName,
            roleId: a.roleId, roleName: a.roleName, roleColor: a.roleColor,
            createdAt: a.createdAt, updatedAt: a.updatedAt,
            createdBy: a.createdBy,
            permissions: a.permissions,
          }}
          // No destructive controls — collaborators only edit content.
          // If the author wants to revoke they do it from THEIR profile.
          rightSlot={
            a.permissions.canEdit && (
              <Link
                to={`/d/${a.id}`}
                title={t("profile.feed.open")}
                aria-label={t("profile.feed.open")}
                className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-muted transition hover:bg-blue-100 hover:text-primary"
              >
                {ICON_EDIT}
              </Link>
            )
          }
        />
      ))}
    </div>
  );
}

function BookmarksTab() {
  const t = useT();
  const [rows, setRows] = useState<{ article: ArticleWithRelations; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const { isBusy, run } = useRowBusy();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.bookmarks.list();
        if (cancelled) return;
        setRows(r.bookmarks);
      } catch (err) {
        if (cancelled) return;
        toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function refresh() {
    try {
      const r = await api.bookmarks.list();
      setRows(r.bookmarks);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function unbookmark(id: string) {
    await run(id, async () => {
      try {
        await api.bookmarks.remove(id);
        toast.success(t("profile.feed.unbookmarked"));
        await refresh();
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  if (loading) return <div className="px-4 py-8 text-sm text-muted">{t("common.loading")}</div>;
  if (rows.length === 0) return <div className="px-4 py-8 text-center text-sm text-muted">{t("profile.feed.noBookmarks")}</div>;
  return (
    <div>
      {rows.map(({ article: a }) => (
        <FeedRow
          key={a.id}
          row={{
            id: a.id, title: a.title,
            folderId: a.folderId,
            folderName: a.folder?.name ?? null,
            roleId: a.role.id,
            roleName: a.role.name,
            roleColor: a.role.color,
            createdAt: a.createdAt, updatedAt: a.updatedAt,
            createdBy: a.createdBy,
            permissions: a.permissions,
          }}
          rightSlot={
            <IconButton title={t("profile.feed.unbookmark")} disabled={isBusy(a.id)} onClick={() => unbookmark(a.id)}>
              {ICON_BOOKMARK_OFF}
            </IconButton>
          }
        />
      ))}
    </div>
  );
}

function LikesTab() {
  const t = useT();
  // The outer entry's `likedAt` is the like timestamp; row.updatedAt
  // is the article timestamp. Renaming from the older `createdAt`
  // collision per audit findings.
  const [rows, setRows] = useState<{ row: FeedArticleRow; likedAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const { isBusy, run } = useRowBusy();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.myLikes();
        if (cancelled) return;
        setRows(r.likes);
      } catch (err) {
        if (cancelled) return;
        toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function refresh() {
    try {
      const r = await api.myLikes();
      setRows(r.likes);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function unlike(id: string) {
    await run(id, async () => {
      try {
        await api.likes.remove(id);
        toast.success(t("profile.feed.unliked"));
        await refresh();
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  if (loading) return <div className="px-4 py-8 text-sm text-muted">{t("common.loading")}</div>;
  if (rows.length === 0) return <div className="px-4 py-8 text-center text-sm text-muted">{t("profile.feed.noLikes")}</div>;
  return (
    <div>
      {rows.map(({ row }) => (
        <FeedRow
          key={row.id}
          row={row}
          rightSlot={
            <IconButton title={t("profile.feed.unlike")} disabled={isBusy(row.id)} onClick={() => unlike(row.id)}>
              {ICON_HEART_OFF}
            </IconButton>
          }
        />
      ))}
    </div>
  );
}
