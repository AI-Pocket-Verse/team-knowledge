import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { Role, UserWithRoles } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { RoleBadge } from "./RoleBadge";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Edit-only: users self-provision via SSO (no admin create / passwords).
  target: UserWithRoles | null;
  roles: Role[];
  selfId: string | null;
  isTargetLastAdmin: boolean;
  onSaved: () => void;
}

export function UserFormDialog({ open, onOpenChange, target, roles, selfId, isTargetLastAdmin, onSaved }: Props) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (target) {
      setIsAdmin(target.isAdmin);
      setIsActive(target.isActive);
      // Admins default to ALL current roles selected (their UserRole rows are
      // usually empty since admins bypass role checks); regular users show
      // their actual assignment. Either way the chips stay editable below.
      setRoleIds(target.isAdmin ? roles.map((r) => r.id) : target.roles.map((r) => r.id));
    }
    setError(null);
  }, [open, target, roles]);

  const isSelf = target?.id === selfId;

  function toggleRole(id: string) {
    setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    setSaving(true);
    try {
      await api.admin.updateUser(target.id, { isAdmin, isActive, roleIds });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label>显示名</Label>
              <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg">
                {target?.displayName}
                <span className="ml-2 text-xs text-muted">（来自飞书，不可修改）</span>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isAdmin}
                disabled={isSelf || (isTargetLastAdmin && target?.isAdmin)}
                onChange={(e) => setIsAdmin(e.target.checked)}
              />
              管理员
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                disabled={isSelf}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              启用
            </label>
            <div className="flex flex-col gap-2">
              <Label>角色</Label>
              <div className="flex flex-wrap gap-2">
                {roles.length === 0 && <span className="text-sm text-muted">尚无角色，请先创建。</span>}
                {roles.map((r) => {
                  const selected = roleIds.includes(r.id);
                  return (
                    <button
                      type="button"
                      key={r.id}
                      onClick={() => toggleRole(r.id)}
                      className={
                        "rounded-full border px-1 py-0.5 transition " +
                        (selected ? "border-primary ring-2 ring-primary/30" : "border-line opacity-60 hover:opacity-100")
                      }
                    >
                      <RoleBadge name={r.name} color={r.color} />
                    </button>
                  );
                })}
              </div>
            </div>
            {error && <div className="text-sm text-rose-600">{error}</div>}
            <div className="mt-2 flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" type="button">取消</Button>
              </DialogClose>
              <Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
            </div>
          </form>
      </DialogContent>
    </Dialog>
  );
}
