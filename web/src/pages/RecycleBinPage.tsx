import { useEffect, useState } from "react";
import type { RecycleBinItem } from "@team-knowledge/shared";
import { api, ApiError, type RecycleBinKind } from "@/lib/api";
import { fmtDate } from "@/lib/relativeTime";
import { DelayedLoader } from "@/components/DelayedLoader";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { tr, useT } from "@/i18n";

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
    return { icon: "🎙", primary: it.title || tr("profile.recycle.noTitleMeeting"), secondary: tr("profile.recycle.meeting") };
  }
  if (it.type === "folder") {
    return {
      icon: "📁",
      primary: it.name || tr("profile.recycle.noNameFolder"),
      secondary: tr("profile.recycle.folderMeta", { role: it.roleName, n: it.docCount }),
    };
  }
  return {
    icon: "📄",
    primary: it.title || tr("profile.recycle.noTitleDoc"),
    secondary: tr("profile.recycle.docMeta", { path: `${it.roleName}${it.folderName ? ` / ${it.folderName}` : ""}` }),
  };
}

export function RecycleBinPage() {
  const t = useT();
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
      toast.success(t("profile.recycle.restored"));
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
      t("profile.recycle.clearConfirm", { n: items.length }),
      { title: t("profile.recycle.clearTitle"), confirmText: t("profile.recycle.clearOk"), danger: true },
    );
    if (!ok) return;
    setBusyKey("__all__");
    try {
      await api.recycleBin.clear();
      toast.success(t("profile.recycle.cleared"));
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
      ? t("profile.recycle.purgeFolder", { name: meta.primary, n: it.docCount })
      : t("profile.recycle.purgeOne", { name: meta.primary });
    const ok = await dialog.confirm(extra, { title: t("profile.recycle.purgeTitle"), confirmText: t("profile.recycle.purge"), danger: true });
    if (!ok) return;
    setBusyKey(itemKey(it));
    try {
      await api.recycleBin.remove(it.type as RecycleBinKind, it.id);
      toast.success(t("profile.recycle.purged"));
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
          <h1 className="text-lg font-semibold text-fg">{t("profile.recycle.title", { n: items.length })}</h1>
          <p className="mt-1 text-xs text-muted">
            {t("profile.recycle.hint")}
          </p>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            disabled={busyKey !== null}
            onClick={() => void clearAll()}
            className="shrink-0 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs text-rose-700 transition enabled:hover:bg-rose-50 disabled:opacity-60"
          >
            {busyKey === "__all__" ? t("profile.recycle.clearing") : t("profile.recycle.clear")}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-line bg-white px-8 py-10 text-center text-sm text-muted shadow-glass">
          {t("profile.recycle.empty")}
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
                  {t("profile.recycle.deletedAt", { date: fmtDate(it.deletedAt) })}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(it)}
                  className="shrink-0 rounded-lg border border-line bg-white px-3 py-1 text-xs text-fg transition enabled:hover:bg-surface disabled:opacity-60"
                >
                  {t("profile.recycle.restore")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void purge(it)}
                  className="shrink-0 rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs text-rose-700 transition enabled:hover:bg-rose-50 disabled:opacity-60"
                >
                  {t("profile.recycle.purge")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
