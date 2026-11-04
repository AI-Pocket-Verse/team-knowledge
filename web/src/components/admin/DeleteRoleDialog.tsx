import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useT } from "@/i18n";

export function DeleteRoleDialog({
  open,
  onOpenChange,
  roleId,
  roleName,
  memberCount,
  folderCount,
  articleCount,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roleId: string;
  roleName: string;
  memberCount: number;
  folderCount: number;
  articleCount: number;
  onDeleted: () => void;
}) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A non-empty role can't be deleted: role.delete hard-cascades every
  // folder/doc (incl. binned ones) past the recycle bin. Pre-disable here to
  // match the server's 409 guard so the destructive action is never offered.
  const hasContent = folderCount > 0 || articleCount > 0;

  async function confirm() {
    setError(null);
    setWorking(true);
    try {
      await api.admin.deleteRole(roleId);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      // A 409 from the API (content appeared after the dialog opened) surfaces
      // its own Chinese message via ApiError.message.
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.roleDelete.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {hasContent ? (
            <p className="text-sm">
              {t("admin.roleDelete.blockedPre")}<span className="font-medium">{roleName}</span>{t("admin.roleDelete.blockedMid1")}<span className="font-medium">{folderCount}</span>{t("admin.roleDelete.blockedMid2", { n: folderCount })}<span className="font-medium">{articleCount}</span>{t("admin.roleDelete.blockedPost", { n: articleCount })}
            </p>
          ) : (
            <p className="text-sm">
              {t("admin.roleDelete.confirmPre")}<span className="font-medium">{roleName}</span>{t("admin.roleDelete.confirmMid")}<span className="font-medium">{memberCount}</span>{t("admin.roleDelete.confirmPost", { n: memberCount })}
            </p>
          )}
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">{t("common.cancel")}</Button>
            </DialogClose>
            <Button type="button" onClick={confirm} disabled={working || hasContent}>{working ? t("admin.deleting") : t("admin.confirmDelete")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
