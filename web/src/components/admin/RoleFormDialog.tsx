import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoleWithMembers } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { useT } from "@/i18n";
import { ROLE_PALETTE, type RoleColorKey } from "@/lib/roleColors";

type Mode = "create" | "edit";

export function RoleFormDialog({
  open,
  onOpenChange,
  mode,
  target,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: Mode;
  target?: RoleWithMembers | null;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<RoleColorKey>("violet");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && target) {
      setName(target.name);
      setDescription(target.description ?? "");
      setColor((target.color as RoleColorKey) ?? "slate");
    } else {
      setName("");
      setDescription("");
      setColor("violet");
    }
    setError(null);
  }, [open, mode, target]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (mode === "create") {
        await api.admin.createRole({ name, description: description || null, color });
      } else if (target) {
        await api.admin.updateRole(target.id, { name, description: description || null, color });
      }
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
          <DialogTitle>{mode === "create" ? t("admin.roleForm.create") : t("admin.roleForm.edit")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">{t("admin.roleForm.name")}</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="desc">{t("admin.roleForm.desc")}</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t("admin.roleForm.color")}</Label>
            <div className="flex flex-wrap gap-2">
              {ROLE_PALETTE.map((c) => (
                <button
                  type="button"
                  key={c.key}
                  aria-label={c.label}
                  aria-pressed={color === c.key}
                  onClick={() => setColor(c.key)}
                  className={
                    "h-7 w-7 rounded-full border transition " +
                    (color === c.key ? "ring-2 ring-primary/40 border-primary" : "border-line")
                  }
                  style={{ background: `linear-gradient(135deg, ${c.from}, ${c.to})` }}
                />
              ))}
            </div>
          </div>
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">{t("common.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
