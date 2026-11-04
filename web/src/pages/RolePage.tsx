import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { WorkspaceRole, WorkspaceTreeResponse, SlimDoc } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { fmtDate } from "@/lib/relativeTime";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { WorkspaceFolderListItem } from "@/components/workspace/WorkspaceFolderListItem";
import { DelayedLoader } from "@/components/DelayedLoader";
import { usePageChrome } from "@/stores/pageChrome";
import { RoleSkillDialogButton } from "@/components/role-skill/RoleSkillPanel";
import { UserName } from "@/components/UserName";
import { docHasReviewBadge, ReviewBadge } from "@/lib/reviewBadge";
import { useT } from "@/i18n";

// Role landing surface at /r/:roleId.
//
// Layout: role hero + a single list mixing folders (with an enter
// chevron when they hold at least one visible doc) and role-direct
// docs. Clicking a folder navigates to /f/:folderId; clicking a doc
// navigates directly to /d/:docId (no slide-in modal — share-friendly).
export function RolePage() {
  const t = useT();
  const { roleId } = useParams<{ roleId: string }>();
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  const [tree, setTree] = useState<WorkspaceTreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 飞书:角色页标题进右区顶栏(role 未加载时退化到路由兜底);Skill 按钮也移到顶栏。
  usePageChrome({
    title: role?.name,
    rightActions: role ? <RoleSkillDialogButton roleId={role.id} roleName={role.name} /> : undefined,
  });

  // Live-sync signal: bumped by the sidebar after it persists a reorder/move.
  const treeNonce = useWorkspaceTree((s) => s.nonce);
  const treeRoleId = useWorkspaceTree((s) => s.roleId);

  useEffect(() => {
    if (!roleId) return;
    let cancelled = false;
    // 切换角色(/r/:roleId 不卸载)时清掉上一个角色的错误与内容。
    setError(null);
    setRole(null);
    setTree(null);
    (async () => {
      try {
        const [rolesRes, treeRes] = await Promise.all([
          api.workspace.listRoles(),
          api.workspace.tree(roleId),
        ]);
        if (cancelled) return;
        const match = rolesRes.roles.find((r) => r.id === roleId);
        if (!match) { setError(t("article.role.notFound")); return; }
        setRole(match);
        setTree(treeRes);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError && err.status === 403 ? t("article.role.forbidden") : (err as Error).message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [roleId]);

  // When the sidebar reorders/moves something in THIS role, refetch just the
  // tree so the right-side list reflects the new order immediately.
  useEffect(() => {
    if (!roleId || treeRoleId !== roleId) return;
    let cancelled = false;
    api.workspace.tree(roleId).then((r) => { if (!cancelled) setTree(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [treeNonce, treeRoleId, roleId]);

  if (error) return <div className="text-rose-600">{error}</div>;
  if (!role || !tree) return <DelayedLoader />;

  const empty = tree.folders.length === 0 && tree.directArticles.length === 0;
  const hint = (
    <>
      {role.description}
      {role.description && role.ownership !== "owned" && t("article.role.hintSep")}
      {role.ownership !== "owned" && t("article.role.readonlyView")}
    </>
  );
  const hasHint = !!role.description || role.ownership !== "owned";

  return (
    <div className="flex flex-col gap-4">
      {/* 标题已在右区顶栏显示;这里只保留描述/只读提示小字(飞书:标题不重复)。 */}
      {hasHint && <p className="text-sm text-muted">{hint}</p>}

      {empty ? (
        <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted shadow-glass">
          {t("article.role.empty")}
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white overflow-hidden shadow-glass">
          {tree.folders.map((f) => (
            <WorkspaceFolderListItem key={f.id} folder={f} />
          ))}
          {tree.directArticles.map((d) => (
            <DocListItem key={d.id} doc={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DocListItem({ doc }: { doc: SlimDoc }) {
  const t = useT();
  return (
    // Card-overlay row: the title <Link>'s ::after covers the whole row so the
    // row navigates to the doc, while the author UserName stays a real sibling
    // link (relative z-10) escaping the overlay — clicking the name opens
    // /u/:id, not the doc. Avoids invalid <a>-inside-<a> nesting.
    <li className="group relative flex items-center gap-3 px-4 py-3 transition hover:bg-surface">
      <DocIcon />
      <div className="min-w-0 flex-1">
        <div className="flex items-center font-medium text-fg group-hover:text-primary transition">
          <span className="min-w-0 max-w-full truncate">
            <Link to={`/d/${doc.id}`} className="after:absolute after:inset-0 after:content-['']">
              {doc.title || t("article.untitled")}
            </Link>
          </span>
          {docHasReviewBadge(doc) && <ReviewBadge title={t("article.feed.reviewBadge")} />}
        </div>
        <div className="mt-0.5 flex items-center gap-4 truncate text-xs text-muted">
          <UserName
            userId={doc.createdBy?.id}
            name={doc.createdBy?.displayName ?? t("article.deletedUser")}
            className="relative z-10 truncate"
          />
          <span className="truncate">{fmtDate(doc.updatedAt)}</span>
        </div>
      </div>
    </li>
  );
}

function DocIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
