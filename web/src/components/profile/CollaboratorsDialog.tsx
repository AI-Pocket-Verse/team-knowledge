import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArticleEditor, UserSearchResult } from "@team-knowledge/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  articleId: string;
  articleTitle: string;
}

/**
 * Manage the per-article editor ACL. Mounted from the "我的文章" row
 * on the profile page; visible only to the article's author + admins
 * (the API enforces this, so an unauthorized open just shows a 403
 * error inline instead of crashing).
 *
 * Layout: top half is an autocomplete search to find + add a user;
 * bottom half lists the currently-granted editors with a remove
 * button per row. Add / remove are immediate (no "save" button) —
 * matches Notion / Linear's collaborator dialogs, where the act of
 * picking a person from the menu IS the grant.
 */
export function CollaboratorsDialog({ open, onOpenChange, articleId, articleTitle }: Props) {
  const [editors, setEditors] = useState<ArticleEditor[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Search state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const r = await api.articles.editors.list(articleId);
      setEditors(r.editors);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [articleId]);

  // Fetch the current editor list every time the dialog opens. We
  // don't keep it warm in background — it's a low-traffic surface and
  // a stale list would be confusing.
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Search-as-you-type. Debounce client-side (180ms) to avoid blasting
  // the backend on every keystroke; cancel earlier in-flight calls by
  // bumping a sequence number — only the LATEST request's result
  // populates state, even if an older one resolves last.
  // NOTE: `editors` is deliberately NOT a dependency. Listing it here
  // re-fired the whole search request for the unchanged query every
  // time a collaborator was added/removed (wasteful + a flicker). The
  // already-granted filtering moved to render time below, so this
  // effect only re-runs when the query itself changes.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) { setResults([]); setSearching(false); return; }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api.searchUsers(q);
        if (seq !== searchSeq.current) return;
        setResults(r.users);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(t);
  }, [open, query]);

  // Hide users already in the editor list — adding them again is a
  // no-op server-side but rendering them in autocomplete is misleading.
  // Filtered at render time (not in the search effect) so add/remove
  // doesn't re-issue the search; reacts immediately to editor changes.
  const visibleResults = useMemo(() => {
    const granted = new Set(editors.map((e) => e.userId));
    return results.filter((u) => !granted.has(u.id));
  }, [results, editors]);

  async function addEditor(userId: string) {
    if (busyUserId) return;
    setBusyUserId(userId);
    try {
      await api.articles.editors.add(articleId, userId);
      await load();
      // Clear the search after a successful add so the user can keep
      // typing the next collaborator without manually clearing first.
      setQuery("");
      setResults([]);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setLoadError(msg);
    } finally {
      setBusyUserId(null);
    }
  }

  async function removeEditor(userId: string) {
    if (busyUserId) return;
    setBusyUserId(userId);
    try {
      await api.articles.editors.remove(articleId, userId);
      setEditors((prev) => prev.filter((e) => e.userId !== userId));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setLoadError(msg);
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>协作者管理</DialogTitle>
          <p className="mt-1 text-xs text-muted">
            为《{articleTitle}》添加可编辑此文档的协作者。协作者只能修改此文档，无法继续给其他人授权。
          </p>
        </DialogHeader>

        {/* Search + add */}
        <div className="mt-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索用户名或显示名…"
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
            autoFocus
          />
          {query.trim() && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-line bg-white shadow-glassLg">
              {searching && <div className="px-3 py-2 text-xs text-muted">搜索中…</div>}
              {!searching && visibleResults.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted">无匹配用户</div>
              )}
              {visibleResults.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={busyUserId === u.id}
                  onClick={() => addEditor(u.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-surface",
                    busyUserId === u.id && "opacity-50",
                  )}
                >
                  <Avatar url={u.avatarUrl} name={u.displayName} />
                  <span className="flex-1 truncate">
                    <span className="font-medium">{u.displayName}</span>
                  </span>
                  <span className="text-xs text-primary">+ 添加</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Existing editors */}
        <div className="mt-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">当前协作者</h4>
          {loading && <div className="text-xs text-muted">加载中…</div>}
          {!loading && editors.length === 0 && !loadError && (
            <div className="text-xs text-muted">尚无协作者。</div>
          )}
          {loadError && (
            <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
              {loadError}
            </div>
          )}
          <ul className="flex flex-col gap-1">
            {editors.map((e) => (
              <li key={e.userId} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm">
                <Avatar url={e.avatarUrl} name={e.displayName} />
                <span className="flex-1 truncate">
                  <span className="font-medium">{e.displayName}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted hover:text-rose-600"
                  disabled={busyUserId === e.userId}
                  onClick={() => removeEditor(e.userId)}
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">关闭</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Tiny avatar — falls back to a colored initial-circle when no
// uploaded avatar URL is present. Inline to keep this dialog
// self-contained (the codebase already has bespoke avatar treatments
// in a few other places; pulling a shared component would invite a
// bigger refactor that isn't related to this feature).
function Avatar({ url, name }: { url: string | null; name: string }) {
  const initial = (name || "?").slice(0, 1).toUpperCase();
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-7 w-7 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
      {initial}
    </span>
  );
}
