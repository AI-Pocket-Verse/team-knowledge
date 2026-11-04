import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/i18n";

export function DeleteUserDialog({
  open,
  onOpenChange,
  userId,
  displayName,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId: string;
  displayName: string;
  onDeleted: () => void;
}) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 409 = 该用户有上传或会议,后端拒绝删除;引导改用停用
  const [hasContent, setHasContent] = useState(false);

  async function confirm() {
    setError(null);
    setHasContent(false);
    setWorking(true);
    try {
      await api.admin.deleteUser(userId);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      setHasContent(err instanceof ApiError && err.status === 409);
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.userDelete.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t("admin.userDelete.confirmPre")}<span className="font-medium">{displayName}</span>{t("admin.userDelete.confirmPost")}
          </p>
          {error && (
            <div className="text-sm text-rose-600">
              {error}
              {hasContent && t("admin.userDelete.disableHint")}
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">{t("common.cancel")}</Button>
            </DialogClose>
            <Button type="button" onClick={confirm} disabled={working}>{working ? t("admin.deleting") : t("admin.confirmDelete")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
