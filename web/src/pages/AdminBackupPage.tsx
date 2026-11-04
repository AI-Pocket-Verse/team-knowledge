import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import type { BackupInfo } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/relativeTime";
import { useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";

export function AdminBackupPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <AdminBackupPageInner />;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AdminBackupPageInner() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The backup row currently being restored (disables its buttons + shows 还原中…).
  const [busyName, setBusyName] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const r = await api.admin.backup.list();
      setBackups(r.backups);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.admin.backup.list();
        if (!cancelled) setBackups(r.backups);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onCreate() {
    setCreating(true);
    try {
      const r = await api.admin.backup.create();
      toast.success(`已备份：${r.backup.name}`);
      await refetch();
    } catch (err) {
      toast.error(`备份失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function onRestore(b: BackupInfo) {
    const ok = await dialog.confirm(
      `将用「${b.name}」(${fmtDateTime(b.createdAt)})覆盖当前数据库${b.hasUploads ? "及上传文件(附件/图片)" : ""}。还原前会自动生成一份安全快照(可回滚)；还原过程中服务会短暂不可用，完成后页面将自动刷新。`,
      { title: "确认还原到此备份？", confirmText: "还原", danger: true },
    );
    if (!ok) return;
    setBusyName(b.name);
    try {
      const r = await api.admin.backup.restore(b.name);
      if (b.hasUploads && !r.uploadsRestored) {
        // DB 已换好,但该备份的上传文件未能还原(如 uploads 跨挂载点)——明确告警,别让人以为附件也回来了。
        toast.error("数据库已还原,但上传文件(附件/图片)未还原,请检查服务器 uploads 目录");
      } else {
        toast.success(r.uploadsRestored ? "已还原(含上传文件),正在刷新页面…" : "已还原,正在刷新页面…");
      }
      // The restore is an in-process hot swap; by the time this resolves the
      // swap is done and the API is back. Reload so the whole app re-reads the
      // restored data.
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      toast.error(`还原失败：${(err as Error).message}`);
      setBusyName(null);
    }
  }

  async function onDelete(b: BackupInfo) {
    const ok = await dialog.confirm(`确定删除备份「${b.name}」？此操作不可恢复。`, {
      title: "删除备份",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.admin.backup.remove(b.name);
      toast.success("已删除");
      await refetch();
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      toast.success("已复制文件路径");
    } catch {
      toast.error("复制失败，请手动选择路径复制");
    }
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-rose-600 text-sm">⚠ {error}</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-muted">
            备份含<strong className="text-fg">整个数据库</strong>(文档正文/历史、评论、点赞、全部配置等)<strong className="text-fg">与上传文件</strong>(附件/图片,标「+附件」的备份含之);还原时一并恢复。手动备份长期保留;每日 03:00 另有自动备份(保留 14 天)。还原为进程内热替换,会先自动生成安全快照。
          </p>
        </div>
        <Button onClick={onCreate} disabled={creating}>
          {creating ? "备份中…" : "立即备份"}
        </Button>
      </div>

      {backups.length === 0 ? (
        <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
          还没有任何备份。点右上角「立即备份」生成第一份。
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                <th className="whitespace-nowrap px-4 py-2 font-medium">时间点</th>
                <th className="whitespace-nowrap px-4 py-2 font-medium">来源</th>
                <th className="whitespace-nowrap px-4 py-2 font-medium">大小</th>
                <th className="px-4 py-2 font-medium">文件位置</th>
                <th className="whitespace-nowrap px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.path} className="border-t border-line align-middle transition hover:bg-surface">
                  <td className="whitespace-nowrap px-4 py-2">{fmtDateTime(b.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span
                      className={
                        b.source === "manual"
                          ? "rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-primary"
                          : "rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-muted"
                      }
                    >
                      {b.source === "manual" ? "手动" : "自动"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">
                    {fmtSize(b.sizeBytes)}
                    {b.hasUploads && (
                      <span
                        className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700"
                        title={`含上传文件(附件/图片)${fmtSize(b.uploadsSizeBytes ?? 0)},还原时一并恢复`}
                      >
                        +附件 {fmtSize(b.uploadsSizeBytes ?? 0)}
                      </span>
                    )}
                  </td>
                  {/* w-full + max-w-0:让本列吃掉剩余宽度,同时禁止按内容撑开
                      (否则长路径会把整张表顶出屏幕)。路径展示拆成「目录(可截断)
                      + 文件名(始终完整)」,等效于隐藏路径中间部分。 */}
                  <td className="w-full max-w-0 px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="flex min-w-0 flex-1 font-mono text-xs text-muted" title={b.path}>
                        <span className="truncate">{b.path.slice(0, b.path.lastIndexOf("/") + 1)}</span>
                        <span className="shrink-0">{b.path.slice(b.path.lastIndexOf("/") + 1)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => copyPath(b.path)}
                        title="复制完整路径"
                        aria-label="复制完整路径"
                        className="shrink-0 rounded p-1 text-muted transition hover:bg-blue-50 hover:text-primary"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyName === b.name}
                        onClick={() => onRestore(b)}
                      >
                        {busyName === b.name ? "还原中…" : "还原"}
                      </Button>
                      {b.source === "manual" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyName === b.name}
                          onClick={() => onDelete(b)}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
