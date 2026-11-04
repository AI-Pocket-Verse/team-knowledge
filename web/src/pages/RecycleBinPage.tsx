import { useEffect, useState } from "react";
import type { RecycleBinItem } from "@team-knowledge/shared";
import { api, ApiError, type RecycleBinKind } from "@/lib/api";
import { fmtDate } from "@/lib/relativeTime";
import { DelayedLoader } from "@/components/DelayedLoader";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { useWorkspaceTree } from "@/stores/workspaceTree";

// 回收站 — the caller's OWN soft-deleted articles / folders / meetings.
// Private per-user (the server only returns items the caller deleted).
// Each item can be 还原 (restored) or 永久删除 (purged). Reached from the
// user-avatar menu (entry sits directly above 退出登录).

function itemKey(it: RecycleBinItem): string {
  return `${it.type}:${it.id}`;
}

// Display glyph + a human label for the item's kind.
function kindMeta(it: RecycleBinItem): { icon: string; primary: string; secondary: string } {
  if (it.type === "meeting") {
    return { icon: "🎙", primary: it.title || "（无标题会议）", secondary: "会议" };
  }
  if (it.type === "folder") {
    return {
      icon: "📁",
      primary: it.name || "（未命名目录）",
      secondary: `目录 ${it.roleName}，含 ${it.docCount} 篇文档`,
    };
  }
  return {
    icon: "📄",
    primary: it.title || "（未命名文档）",
    secondary: `文档 ${it.roleName}${it.folderName ? ` / ${it.folderName}` : ""}`,
  };
}

export function RecycleBinPage() {
  const [items, setItems] = useState<RecycleBinItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);

  async function refetch() {
    try {
      const r = await api.recycleBin.list();
      setItems(r.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refetch(); }, []);

  // Nudge the left rail to refetch a role's subtree after a doc/folder
  // comes back, so the restored item reappears without a manual reload.
  function refreshRoleFor(it: RecycleBinItem) {
    if (it.type === "folder" || it.type === "article") requestRoleRefresh(it.roleId);
  }

  async function restore(it: RecycleBinItem) {
    setBusyKey(itemKey(it));
    try {
      await api.recycleBin.restore(it.type as RecycleBinKind, it.id);
      toast.success("已还原");
      refreshRoleFor(it);
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function clearAll() {
    const ok = await dialog.confirm(
      `回收站中的 ${items.length} 项内容（含目录内的文档）将被全部永久删除，无法恢复。`,
      { title: "清空回收站？", confirmText: "全部永久删除", danger: true },
    );
    if (!ok) return;
    setBusyKey("__all__");
    try {
      await api.recycleBin.clear();
      toast.success("回收站已清空");
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function purge(it: RecycleBinItem) {
    const meta = kindMeta(it);
    const extra = it.type === "folder" && it.docCount > 0
      ? `「${meta.primary}」及其中 ${it.docCount} 篇文档将被永久删除，无法恢复。`
      : `「${meta.primary}」将被永久删除，无法恢复。`;
    const ok = await dialog.confirm(extra, { title: "永久删除？", confirmText: "永久删除", danger: true });
    if (!ok) return;
    setBusyKey(itemKey(it));
    try {
      await api.recycleBin.remove(it.type as RecycleBinKind, it.id);
      toast.success("已永久删除");
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-rose-600">{error}</div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-fg">回收站 ({items.length})</h1>
          <p className="mt-1 text-xs text-muted">
            这里只有你自己删除的内容，其他人看不到。可以还原，或永久删除以彻底清除。
          </p>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            disabled={busyKey !== null}
            onClick={() => void clearAll()}
            className="shrink-0 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs text-rose-700 transition enabled:hover:bg-rose-50 disabled:opacity-60"
          >
            {busyKey === "__all__" ? "清空中…" : "清空回收站"}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-line bg-white px-8 py-10 text-center text-sm text-muted shadow-glass">
          回收站是空的。删除文档、目录或会议后，会先放到这里。
        </div>
      ) : (
        <ul className="rounded-xl border border-line bg-white shadow-glass divide-y divide-line">
          {items.map((it) => {
            const meta = kindMeta(it);
            // 单项操作只锁本行;「清空回收站」进行中锁全部行(清空会动到所有项)。
            const busy = busyKey === itemKey(it) || busyKey === "__all__";
            return (
              <li key={itemKey(it)} className="flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-surface">
                <span aria-hidden className="text-base">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">{meta.primary}</div>
                  <div className="truncate text-xs text-muted">{meta.secondary}</div>
                </div>
                <span className="shrink-0 text-xs text-muted">
                  删除于 {fmtDate(it.deletedAt)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(it)}
                  className="shrink-0 rounded-lg border border-line bg-white px-3 py-1 text-xs text-fg transition enabled:hover:bg-surface disabled:opacity-60"
                >
                  还原
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void purge(it)}
                  className="shrink-0 rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs text-rose-700 transition enabled:hover:bg-rose-50 disabled:opacity-60"
                >
                  永久删除
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
