import { useEffect, useState, useCallback } from "react";
import { Outlet, useParams } from "react-router-dom";
import type { FolderWithRole } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { WorkspaceFolderProvider } from "@/lib/workspaceFolderContext";
import { DelayedLoader } from "@/components/DelayedLoader";
import { usePageChrome } from "@/stores/pageChrome";
import { tr } from "@/i18n";

export function WorkspacePage() {
  // Folder landing at /f/:folderId.
  const { folderId } = useParams<{ folderId: string }>();
  const [folder, setFolder] = useState<FolderWithRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!folderId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.workspace.getFolder(folderId);
      setFolder(res.folder);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setError(tr("workspace.folderGone"));
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => { void refetch(); }, [refetch]);

  // 飞书:目录页标题进右区顶栏(folder 未加载时退化到路由兜底)。
  usePageChrome({ title: folder?.name });

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-red-600">{error}</div>;
  if (!folder) return null;

  return (
    <WorkspaceFolderProvider value={{ folder, permissions: folder.permissions, refetch }}>
      <Outlet />
    </WorkspaceFolderProvider>
  );
}
