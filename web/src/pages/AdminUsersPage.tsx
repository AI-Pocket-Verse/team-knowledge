import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import type { Role, UserWithRoles } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/relativeTime";
import { useAuth, useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { Button } from "@/components/ui/button";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { UserFormDialog } from "@/components/admin/UserFormDialog";
import { DeleteUserDialog } from "@/components/admin/DeleteUserDialog";
import { useT } from "@/i18n";

// "用户" page is admin-only. Non-admins have no pages inside /admin
// (folders are managed from the workspace sidebar), so we bounce
// them back to the workspace home.
export function AdminUsersPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <AdminUsersPageInner />;
}

function AdminUsersPageInner() {
  const t = useT();
  const me = useAuth((s) => s.user);
  const [users, setUsers] = useState<UserWithRoles[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formTarget, setFormTarget] = useState<UserWithRoles | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<UserWithRoles | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.admin.listUsers(), api.admin.listRoles()]);
      setUsers(u.users);
      setRoles(r.roles);
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
        const [u, r] = await Promise.all([api.admin.listUsers(), api.admin.listRoles()]);
        if (cancelled) return;
        setUsers(u.users);
        setRoles(r.roles);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const adminCount = useMemo(() => users.filter((u) => u.isAdmin && u.isActive).length, [users]);

  function openEdit(u: UserWithRoles) {
    setFormTarget(u);
    setFormOpen(true);
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-rose-600">{error}</div>;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-muted">{t("admin.users.hint")}</p>

      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">{t("admin.users.name")}</th>
              <th className="px-4 py-2.5 font-medium">{t("admin.users.email")}</th>
              <th className="px-4 py-2.5 font-medium">{t("admin.userForm.roles")}</th>
              <th className="px-4 py-2.5 font-medium">{t("admin.users.status")}</th>
              <th className="px-4 py-2.5 font-medium">{t("admin.users.createdAt")}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t("admin.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === me?.id;
              const isLastAdmin = u.isAdmin && u.isActive && adminCount === 1;
              return (
                <tr key={u.id} className="border-t border-line transition hover:bg-surface">
                  <td className="px-4 py-2.5 font-medium">{u.displayName}</td>
                  <td className="px-4 py-2.5 text-muted">{u.email ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {u.isAdmin ? (
                        <span
                          className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-primary"
                          title={t("admin.users.allRolesTip")}
                        >
                          {t("admin.users.allRoles")}
                        </span>
                      ) : u.roles.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        u.roles.map((r) => (
                          <RoleBadge key={r.id} name={r.name} color={r.color} />
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {u.isActive ? (
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-primary">{t("admin.userForm.active")}</span>
                    ) : (
                      <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{t("admin.users.disabled")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{fmtDate(u.createdAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>{t("common.edit")}</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(u)}
                        disabled={isSelf || isLastAdmin}
                        title={
                          isSelf
                            ? t("admin.users.cantDeleteSelf")
                            : isLastAdmin
                              ? t("admin.users.cantDeleteLastAdmin")
                              : undefined
                        }
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <UserFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        target={formTarget}
        roles={roles}
        selfId={me?.id ?? null}
        isTargetLastAdmin={!!formTarget && formTarget.isAdmin && adminCount === 1}
        onSaved={refetch}
      />

      {deleteTarget && (
        <DeleteUserDialog
          open={!!deleteTarget}
          onOpenChange={(v) => !v && setDeleteTarget(null)}
          userId={deleteTarget.id}
          displayName={deleteTarget.displayName}
          onDeleted={refetch}
        />
      )}
    </div>
  );
}
