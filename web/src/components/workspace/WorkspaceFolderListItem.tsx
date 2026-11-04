import { Link } from "react-router-dom";
import type { FolderRow } from "@team-knowledge/shared";
import { folderHasReviewIssues, ReviewBadge } from "@/lib/reviewBadge";
import { useT } from "@/i18n";

// One folder row in a "container" list — shared by the role view (RolePage)
// and the folder view (ArticleListPage). A folder counts as having content if
// it holds docs OR subfolders: a folder that only contains subfolders is still
// enterable (it must NOT read as "暂无文档" / greyed-out non-clickable).
export function WorkspaceFolderListItem({ folder }: { folder: FolderRow }) {
  const t = useT();
  const docCount = folder.articles.length;
  const subCount = folder.children.length;
  const hasContent = docCount > 0 || subCount > 0;
  const summary = hasContent
    ? [subCount > 0 ? t("workspace.folder.subCount", { n: subCount }) : null, docCount > 0 ? t("workspace.folder.docCount", { n: docCount }) : null]
        .filter(Boolean)
        .join(" · ")
    : t("workspace.folder.empty");

  const Body = (
    <div className="flex items-center gap-3 px-4 py-3">
      <FolderIcon dim={!hasContent} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center font-medium text-fg">
          <span className="min-w-0 max-w-full truncate">{folder.name}</span>
          {folderHasReviewIssues(folder) && <ReviewBadge title={t("workspace.folder.hasIssues")} />}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{summary}</div>
      </div>
      {hasContent && (
        <span className="text-muted/70" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      )}
    </div>
  );
  // Empty folder → non-clickable greyed row (clear "nothing to open" signal).
  if (!hasContent) return <li className="cursor-default opacity-70">{Body}</li>;
  return (
    <li>
      <Link to={`/f/${folder.id}`} className="block transition hover:bg-surface" title={t("workspace.folder.enter", { name: folder.name })}>
        {Body}
      </Link>
    </li>
  );
}

function FolderIcon({ dim }: { dim?: boolean }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={dim ? "text-muted/50" : "text-primary/80"}
      aria-hidden
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
