import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

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
          <DialogTitle>删除角色</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {hasContent ? (
            <p className="text-sm">
              无法删除角色「<span className="font-medium">{roleName}</span>」:
              请先删除或迁移该角色下的 <span className="font-medium">{folderCount}</span> 个目录、
              <span className="font-medium">{articleCount}</span> 篇文档。
            </p>
          ) : (
            <p className="text-sm">
              确认删除角色「<span className="font-medium">{roleName}</span>」？
              该角色及其 <span className="font-medium">{memberCount}</span> 名成员的绑定关系会被删除，但用户本身不受影响。
            </p>
          )}
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">取消</Button>
            </DialogClose>
            <Button type="button" onClick={confirm} disabled={working || hasContent}>{working ? "删除中…" : "确认删除"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
