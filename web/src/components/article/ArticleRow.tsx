import { Link } from "react-router-dom";
import type { ArticleSummary } from "@team-knowledge/shared";
import { UserName } from "@/components/UserName";
import { formatTimestamp } from "@/lib/format";
import { useT } from "@/i18n";

interface Props {
  article: ArticleSummary;
  onToggleBookmark: (id: string, isBookmarked: boolean) => void;
}

export function ArticleRow({ article: a, onToggleBookmark }: Props) {
  const t = useT();
  // Card-style list item. The outer wrapper is an <article> (no
  // navigation), with the title <Link>'s `::after` extended to cover
  // the whole card via `after:absolute after:inset-0` — this makes
  // the entire card clickable while keeping the bookmark <button> as
  // a real sibling, avoiding the invalid `<button>`-inside-`<a>`
  // nesting an earlier version had.
  const detailPath = `/d/${a.id}`;
  return (
    <article className="group relative flex gap-4 rounded-xl border border-line bg-white px-5 py-4 transition hover:border-primary/40 hover:shadow-glass">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 pr-7">
          <h3 className="truncate text-base font-semibold text-fg group-hover:text-primary">
            {/* The link covers the whole card via its ::after — but
                only the visible text receives focus/tab order, which
                is good for keyboard navigation. */}
            <Link
              to={detailPath}
              className="after:absolute after:inset-0 after:rounded-xl after:content-['']"
            >
              {a.title || t("article.untitled")}
            </Link>
          </h3>
        </div>
        <p className="mt-1 line-clamp-1 text-sm text-muted">
          {a.preview && a.preview.length > 0 ? a.preview : <span className="italic text-muted/60">{t("article.row.noContent")}</span>}
        </p>
        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          {/* `relative z-10` lifts the author link above the title link's
              ::after card overlay so the name click navigates to /u/:id. */}
          <UserName
            userId={a.createdBy?.id}
            name={a.createdBy?.displayName ?? t("article.deletedUser")}
            className="relative z-10"
          />
          <span>{formatTimestamp(a.updatedAt)}</span>
        </div>
      </div>

      {a.firstImage && (
        // Fixed-height thumbnail, aspect preserved via object-cover.
        <img
          src={a.firstImage}
          alt=""
          loading="lazy"
          className="h-20 w-32 shrink-0 self-center rounded-lg object-cover"
        />
      )}

      <button
        type="button"
        onClick={() => onToggleBookmark(a.id, a.isBookmarked)}
        aria-label={a.isBookmarked ? t("article.action.unbookmark") : t("article.action.bookmark")}
        // `relative z-10` lifts the button above the title link's
        // ::after overlay so clicks land on the button, not the link.
        className={
          "absolute right-3 top-3 z-10 text-base transition " +
          (a.isBookmarked ? "text-amber-500" : "text-muted/40 hover:text-amber-400")
        }
      >
        ★
      </button>
    </article>
  );
}
