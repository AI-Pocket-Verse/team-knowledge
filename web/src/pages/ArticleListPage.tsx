import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { FolderRow } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { useWorkspaceFolder } from "@/lib/workspaceFolderContext";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { ArticleTimeFeed } from "@/components/article/ArticleTimeFeed";
import { WorkspaceFolderListItem } from "@/components/workspace/WorkspaceFolderListItem";
import { useT } from "@/i18n";

// Locate a folder node anywhere in the (depth-capped-at-2) tree by id, so the
// folder page can read off its subfolders.
function findFolder(folders: FolderRow[], id: string): FolderRow | null {
  for (const f of folders) {
    if (f.id === id) return f;
    const child = f.children.find((c) => c.id === id);
    if (child) return child;
  }
  return null;
}

// Folder landing surface at /f/:folderId. Renders this folder's SUBFOLDERS
// (above) + its docs (below). Subfolders come from the role tree; the doc list
// is the time-flow feed. The "+ 新建文档" CTA flows through the sidebar's +.
export function ArticleListPage() {
  const t = useT();
  const { folderId } = useParams<{ folderId: string }>();
  const { folder, permissions } = useWorkspaceFolder();
  const roleId = folder.role.id;
  const [subfolders, setSubfolders] = useState<FolderRow[]>([]);
  // Live-sync: re-pull subfolders when the sidebar persists a reorder/move.
  const treeNonce = useWorkspaceTree((s) => s.nonce);

  useEffect(() => {
    if (!folderId) return;
    let cancelled = false;
    api.workspace
      .tree(roleId)
      .then((tree) => { if (!cancelled) setSubfolders(findFolder(tree.folders, folderId)?.children ?? []); })
      .catch(() => { /* best-effort — the doc feed still renders without the strip */ });
    return () => { cancelled = true; };
  }, [folderId, roleId, treeNonce]);

  if (!folderId) return null;

  return (
    <ArticleTimeFeed
      mode={{ kind: "folder", folderId: folderId, folderName: folder.name }}
      header={
        <div className="flex flex-col gap-4">
          {permissions.isReadOnly && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {t("article.list.readonly")}
            </div>
          )}
          {/* 标题已在右区顶栏显示;这里只保留目录描述小字(飞书:标题不重复)。 */}
          {folder.description && <p className="text-sm text-muted">{folder.description}</p>}
          {subfolders.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold text-muted">{t("article.list.subfolders")}</div>
              <ul className="divide-y divide-line rounded-xl border border-line bg-white overflow-hidden shadow-glass">
                {subfolders.map((f) => (
                  <WorkspaceFolderListItem key={f.id} folder={f} />
                ))}
              </ul>
            </div>
          )}
        </div>
      }
    />
  );
}
