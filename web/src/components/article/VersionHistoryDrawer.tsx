import { useEffect, useRef, useState } from "react";
import type { ArticleVersion } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/relativeTime";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";

export function VersionHistoryDrawer({
  open,
  onClose,
  articleId,
  // When true (viewer canEdit && article not archived), each version row
  // gets a "回滚到此版本" button. Read-only viewers see history without it.
  canRestore = false,
  // Fired after a successful restore so the host can refresh the article
  // view / editor to reflect the reverted content.
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  articleId: string;
  canRestore?: boolean;
  onRestored?: () => void;
}) {
  const [versions, setVersions] = useState<ArticleVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Per-version in-flight guard so a double-click can't fire two restores.
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.articles.versions(articleId)
      .then((r) => setVersions(r.versions))
      .finally(() => setLoading(false));
  }, [open, articleId]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus first focusable element on open
  useEffect(() => {
    if (!open) return;
    const node = asideRef.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>("button, [href], input, [tabindex]");
    focusable?.focus();
  }, [open]);

  async function restore(versionId: string) {
    if (restoringId) return;
    const ok = await dialog.confirm("文档的标题与正文将回滚到该版本，当前内容会被存入历史记录，可再次回滚。", {
      title: "确认回滚到此版本？",
      confirmText: "回滚",
    });
    if (!ok) return;
    setRestoringId(versionId);
    try {
      await api.articles.restoreVersion(articleId, versionId);
      toast.success("已回滚到该版本");
      // Refresh the version list so the new pre-restore snapshot shows up.
      const r = await api.articles.versions(articleId);
      setVersions(r.versions);
      onRestored?.();
    } catch (err) {
      toast.error(`回滚失败：${(err as Error).message}`);
    } finally {
      setRestoringId(null);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside
        ref={asideRef}
        role="dialog"
        aria-modal="true"
        aria-label="历史版本"
        className="fixed right-0 top-0 z-50 h-full w-[28rem] overflow-y-auto bg-white shadow-pop border-l border-line"
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-line bg-white px-4 py-3">
          <div className="text-sm font-semibold">历史版本 ({versions.length})</div>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </header>
        <div className="flex flex-col">
          {loading && <div className="p-4 text-sm text-muted">加载中…</div>}
          {!loading && versions.length === 0 && (
            <div className="p-4 text-sm text-muted">尚无历史版本</div>
          )}
          {versions.map((v) => {
            const expanded = expandedId === v.id;
            return (
              <div key={v.id} className="border-b border-line">
                {/* Row header: click the left region to expand the content
                    preview; the 回滚 button sits alongside (NOT nested inside
                    the expand button) so restoring is one click without
                    drilling into the preview. */}
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : v.id)}
                    className="flex flex-1 items-center justify-between gap-2 px-4 py-3 text-left text-sm transition hover:bg-surface"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{v.title}</span>
                      <span className="text-xs text-muted">
                        {fmtDateTime(v.createdAt)} {v.authorDisplayName ?? "（已删除）"}
                      </span>
                    </div>
                  </button>
                  {canRestore && (
                    <div className="flex items-center pr-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs whitespace-nowrap"
                        disabled={restoringId === v.id}
                        onClick={() => restore(v.id)}
                        title="回滚到此版本"
                      >
                        {restoringId === v.id ? "回滚中…" : "回滚"}
                      </Button>
                    </div>
                  )}
                </div>
                {expanded && (
                  <div className="bg-surface">
                    <pre className="px-4 py-3 text-xs whitespace-pre-wrap text-fg">
                      {v.contentMarkdown || "（空）"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
