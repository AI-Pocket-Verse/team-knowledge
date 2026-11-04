import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import type { RoleWithMembers } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { RoleSkillDialogButton } from "@/components/role-skill/RoleSkillPanel";
import { RoleFormDialog } from "@/components/admin/RoleFormDialog";
import { DeleteRoleDialog } from "@/components/admin/DeleteRoleDialog";

// The admin roles list endpoint augments each role with live content counts
// (folders + articles, incl. binned) that the shared RoleWithMembers type
// predates — the shared package isn't owned by the web app, so we widen it
// here. DeleteRoleDialog uses these to block deleting a non-empty role
// (role.delete hard-cascades all its folders/docs past the recycle bin).
type RoleRow = RoleWithMembers & { folderCount?: number; articleCount?: number };

// "角色" management is admin-only. Non-admins no longer have any
// pages inside /admin (the "目录" page is gone), so we just bounce
// them back to the workspace home.
export function AdminRolesPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <AdminRolesPageInner />;
}

function AdminRolesPageInner() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<RoleRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleRow | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await api.admin.listRoles();
      setRoles(res.roles);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.admin.listRoles();
        if (cancelled) return;
        setRoles(res.roles);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function openCreate() {
    setFormMode("create");
    setFormTarget(null);
    setFormOpen(true);
  }
  function openEdit(r: RoleRow) {
    setFormMode("edit");
    setFormTarget(r);
    setFormOpen(true);
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-rose-600">{error}</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <Button onClick={openCreate}>+ 新建角色</Button>
      </div>

      {roles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <p className="text-muted">尚无角色</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">名称</th>
                <th className="px-4 py-2.5 font-medium">描述</th>
                <th className="px-4 py-2.5 font-medium">成员</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id} className="border-t border-line transition hover:bg-surface">
                  <td className="px-4 py-2.5"><RoleBadge name={r.name} color={r.color} /></td>
                  <td className="px-4 py-2.5 text-muted">{r.description ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{r.memberCount}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1 align-middle">
                      <RoleSkillDialogButton
                        roleId={r.id}
                        roleName={r.name}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-fg/70 transition hover:bg-blue-50 hover:text-primary"
                      />
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>编辑</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(r)}>删除</Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RoleFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        mode={formMode}
        target={formTarget}
        onSaved={refetch}
      />

      {deleteTarget && (
        <DeleteRoleDialog
          open={!!deleteTarget}
          onOpenChange={(v) => !v && setDeleteTarget(null)}
          roleId={deleteTarget.id}
          roleName={deleteTarget.name}
          memberCount={deleteTarget.memberCount}
          folderCount={deleteTarget.folderCount ?? 0}
          articleCount={deleteTarget.articleCount ?? 0}
          onDeleted={refetch}
        />
      )}
    </div>
  );
}
