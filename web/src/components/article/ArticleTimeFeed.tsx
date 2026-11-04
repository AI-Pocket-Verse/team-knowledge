import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FeedArticleRow, WorkspaceRole } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/relativeTime";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { cn } from "@/lib/cn";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { UserName } from "@/components/UserName";
import { DelayedLoader } from "@/components/DelayedLoader";
import { docHasReviewBadge, ReviewBadge } from "@/lib/reviewBadge";
import { useT } from "@/i18n";

// Inbox-style time-flow used by the folder landing page (/f/:folderId).
// Layout: chip filter row on top (only in mode="all") + vertical
// time-ordered list. Clicking a row navigates straight to /d/:id —
// bookmark/share-friendly URLs across the board.
//
// Filters happen server-side via api.feed({ roleId, folderId }).
type Mode =
  | { kind: "all" }
  | { kind: "role"; roleId: string; roleName?: string }
  | { kind: "folder"; folderId: string; folderName?: string; roleId?: string };

interface Props {
  mode: Mode;
  // Header content rendered above the chip row (page-specific title /
  // breadcrumb). Optional so the home page can render its greeting
  // inline while /r and /f pages can show the role/folder hero.
  header?: React.ReactNode;
  // Right-side adornment of the chip row (e.g. "+ 新建文档" button on
  // folder pages where the caller has canEdit).
  rightSlot?: React.ReactNode;
}

export function ArticleTimeFeed({ mode, header, rightSlot }: Props) {
  const t = useT();
  const [roles, setRoles] = useState<WorkspaceRole[]>([]);
  const [articles, setArticles] = useState<FeedArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Chip filter only applies in mode="all". For role/folder modes the
  // filter is fixed by the URL and we hide the chip row.
  const [chipRoleId, setChipRoleId] = useState<string | "all">("all");

  // Fetch the role list once for the chip row (only visible on `/`).
  useEffect(() => {
    if (mode.kind !== "all") return;
    let cancelled = false;
    (async () => {
      try {
        const { roles: rs } = await api.workspace.listRoles();
        if (!cancelled) setRoles(rs);
      } catch { /* ignore — feed still renders, chips just empty */ }
    })();
    return () => { cancelled = true; };
  }, [mode.kind]);

  // Pull the discriminating PRIMITIVES out of `mode` so the fetch effect can
  // depend on stable string values. Parent pages (e.g. ArticleListPage) pass
  // `mode` as a fresh object literal every render, so depending on `mode`
  // itself re-ran this effect — and re-fetched the feed with a loading flash —
  // on every unrelated parent re-render.
  const modeKind = mode.kind;
  const modeRoleId = mode.kind === "role" ? mode.roleId : undefined;
  const modeFolderId = mode.kind === "folder" ? mode.folderId : undefined;
  // Live-sync: bumped when the sidebar persists a reorder/move. Adding it to the
  // fetch deps below re-pulls the feed so a folder/role view reflects the new
  // order immediately (no manual refresh).
  const treeNonce = useWorkspaceTree((s) => s.nonce);

  // Fetch the feed every time the mode primitives or chip selection change.
  // The server applies all permission filters; we just render what comes
  // back. Errors surface in-place so a single bad fetch doesn't
  // unmount the whole shell.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const filter: { roleId?: string; folderId?: string } = {};
    if (modeKind === "role") filter.roleId = modeRoleId;
    else if (modeKind === "folder") filter.folderId = modeFolderId;
    else if (chipRoleId !== "all") filter.roleId = chipRoleId;
    (async () => {
      try {
        const r = await api.feed(filter);
        if (!cancelled) setArticles(r.articles);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [modeKind, modeRoleId, modeFolderId, chipRoleId, treeNonce]);

  const showChips = mode.kind === "all";

  const empty = !loading && !error && articles.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {header}

      {showChips && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={chipRoleId === "all"} onClick={() => setChipRoleId("all")}>
            {t("article.feed.all")}
          </Chip>
          {roles.map((r) => (
            <Chip
              key={r.id}
              active={chipRoleId === r.id}
              onClick={() => setChipRoleId(r.id)}
            >
              {r.name}
            </Chip>
          ))}
          {rightSlot && <div className="ml-auto">{rightSlot}</div>}
        </div>
      )}
      {!showChips && rightSlot && (
        <div className="flex justify-end">{rightSlot}</div>
      )}

      {loading && <DelayedLoader />}
      {error && <div className="text-rose-600 text-sm">⚠ {error}</div>}

      {empty && (
        <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted shadow-glass">
          {mode.kind === "all"
            ? t("article.feed.emptyAll")
            : mode.kind === "role"
              ? t("article.feed.emptyRole")
              : t("article.feed.emptyFolder")}
        </div>
      )}


      {!loading && !error && articles.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white overflow-hidden shadow-glass">
          {articles.map((a) => (
            // Card-overlay row: the title <Link>'s ::after covers the whole
            // row so the entire row navigates to the doc, while the author
            // UserName stays a real sibling link (relative z-10) that escapes
            // the overlay — clicking the name opens /u/:id, not the doc. This
            // avoids the invalid <a>-inside-<a> nesting a wrapping row Link had.
            <li
              key={a.id}
              className="group relative flex items-center gap-3 px-4 py-3 transition hover:bg-surface"
            >
              <RoleBadge name={a.roleName} color={a.roleColor} variant="soft" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center font-medium text-fg group-hover:text-primary transition">
                  <span className="min-w-0 max-w-full truncate">
                    <Link to={`/d/${a.id}`} className="after:absolute after:inset-0 after:content-['']">
                      {a.title}
                    </Link>
                  </span>
                  {docHasReviewBadge(a) && <ReviewBadge title={t("article.feed.reviewBadge")} />}
                </div>
                <div className="mt-0.5 flex items-center gap-4 truncate text-xs text-muted">
                  {a.folderName && <span className="truncate">{a.folderName}</span>}
                  <UserName
                    userId={a.createdBy?.id}
                    name={a.createdBy?.displayName ?? t("article.deletedUser")}
                    className="relative z-10 truncate"
                  />
                  <span className="truncate">{fmtDate(a.updatedAt)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Pill-shaped (rounded-full) filter chip mirroring sub.png's
        // toolbar — active chip is solid lavender, idle reads as a
        // hairline-bordered pill so the row sits on top of the white
        // surface without competing for attention.
        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-primary bg-primary text-primary-fg shadow-sm"
          : "border-line bg-white text-fg/70 hover:border-primary/30 hover:bg-blue-50 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

// (列表里的时间统一显示为 yyyy-mm-dd,见 fmtDate;相对时间只保留在实时动态/动态流。)
