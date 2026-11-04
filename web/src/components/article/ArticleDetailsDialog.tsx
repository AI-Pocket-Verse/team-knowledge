import { useEffect, useState } from "react";
import type { ArticleWithRelations, ArticleViewsResponse } from "@team-knowledge/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { UserName } from "@/components/UserName";
import { countArticleWords } from "@/lib/wordCount";
import { fmtRelativeTime } from "@/lib/relativeTime";
import { useI18n } from "@/i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  article: ArticleWithRelations;
}

// Human-readable byte size. Documents are markdown text, so they rarely
// exceed a few hundred KB — B / KB is enough granularity (no MB tier
// needed for the doc-detail surface).
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 文档详情 dialog — opened from the ⋯ actions menu on the doc view page.
 * Shows authorship + timestamps + size metrics computed client-side from
 * the already-loaded article, plus 访问量 / 独立访客 / 谁看过 fetched lazily
 * from GET /api/articles/:id/views when the dialog opens. The viewer list
 * is author/admin/collaborator-only (server gates `canSeeViewers`); other
 * viewers see the aggregate counts plus a note explaining the list is hidden.
 */
export function ArticleDetailsDialog({ open, onOpenChange, article }: Props) {
  const { t, lang } = useI18n();
  const [views, setViews] = useState<ArticleViewsResponse | null>(null);
  const [viewsError, setViewsError] = useState<string | null>(null);

  // Fetch view stats every time the dialog opens. Low-traffic surface —
  // not kept warm in the background; a stale count would be confusing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setViews(null);
    setViewsError(null);
    api.articles
      .views(article.id)
      .then((r) => { if (!cancelled) setViews(r); })
      .catch((err) => { if (!cancelled) setViewsError((err as Error).message); });
    return () => { cancelled = true; };
  }, [open, article.id]);

  const wordCount = countArticleWords(article.contentMarkdown);
  const byteSize = new TextEncoder().encode(article.contentMarkdown).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("article.details.title")}</DialogTitle>
        </DialogHeader>

        {/* Metadata grid: label (muted) | value. */}
        <dl className="mt-4 grid grid-cols-[5rem_1fr] gap-y-2.5 text-sm">
          <dt className="text-muted">{t("article.details.author")}</dt>
          <dd className="font-medium">
            <UserName userId={article.createdBy?.id} name={article.createdBy?.displayName ?? t("article.deletedUser")} />
          </dd>

          <dt className="text-muted">{t("article.details.created")}</dt>
          <dd>{fmtRelativeTime(article.createdAt)}</dd>

          <dt className="text-muted">{t("article.details.modified")}</dt>
          <dd>{fmtRelativeTime(article.updatedAt)}</dd>

          <dt className="text-muted">{t("article.details.words")}</dt>
          <dd>{t("article.details.wordsValue", { n: wordCount.toLocaleString(lang === "zh" ? "zh-CN" : "en-US") })}</dd>

          <dt className="text-muted">{t("article.details.size")}</dt>
          <dd>{formatBytes(byteSize)}</dd>

          <dt className="text-muted">{t("article.details.views")}</dt>
          <dd>{views ? views.pv.toLocaleString() : "…"}</dd>

          <dt className="text-muted">{t("article.details.uniqueViewers")}</dt>
          <dd>{views ? views.uniqueViewers.toLocaleString() : "…"}</dd>
        </dl>

        {/* 谁看过 — only when the server says we may see the list. */}
        <div className="mt-4 border-t border-line pt-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("article.details.whoViewed")}</h4>
          {viewsError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
              {viewsError}
            </div>
          )}
          {!viewsError && !views && (
            <div className="text-xs text-muted">{t("common.loading")}</div>
          )}
          {views && !views.canSeeViewers && (
            <div className="text-xs text-muted">{t("article.details.viewersHidden")}</div>
          )}
          {views && views.canSeeViewers && views.viewers && views.viewers.length === 0 && (
            <div className="text-xs text-muted">{t("article.details.noViewers")}</div>
          )}
          {views && views.canSeeViewers && views.viewers && views.viewers.length > 0 && (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {views.viewers.map((v) => (
                <li
                  key={v.user.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-surface"
                >
                  <Avatar url={v.user.avatarUrl} name={v.user.displayName} />
                  <span className="flex-1 truncate font-medium">{v.user.displayName}</span>
                  <span className="shrink-0 text-xs text-muted">{fmtRelativeTime(v.lastViewedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">{t("common.close")}</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Tiny avatar — colored initial-circle fallback when no uploaded avatar.
// Inline to keep this dialog self-contained (matches CollaboratorsDialog's
// local Avatar; a shared component would invite an unrelated refactor).
function Avatar({ url, name }: { url: string | null; name: string }) {
  const initial = (name || "?").slice(0, 1).toUpperCase();
  if (url) {
    return <img src={url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
      {initial}
    </span>
  );
}
