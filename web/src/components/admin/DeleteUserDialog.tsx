import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";

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
          <DialogTitle>删除用户</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            确认删除「<span className="font-medium">{displayName}</span>」吗？该操作无法撤销。
          </p>
          {error && (
            <div className="text-sm text-rose-600">
              {error}
              {hasContent && "（在用户列表中把该用户改为「禁用」即可保留其内容）"}
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">取消</Button>
            </DialogClose>
            <Button type="button" onClick={confirm} disabled={working}>{working ? "删除中…" : "确认删除"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
