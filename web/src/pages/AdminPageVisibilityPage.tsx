import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useIsAdmin, useAuth } from "@/stores/auth";
import { toast } from "@/components/Toaster";
import { useT } from "@/i18n";

type Row = { key: string; label: string; visibility: "admin" | "all" };

export function AdminPageVisibilityPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <Inner />;
}

function Inner() {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    void api.adminPageVisibility.get().then((r) => setRows(r.pages)).catch(() => setRows([]));
  }, []);

  async function setVis(key: string, visibility: "admin" | "all") {
    setSavingKey(key);
    try {
      const r = await api.adminPageVisibility.set(key, visibility);
      setRows(r.pages);
      // 同步刷新全局 admin-access,使本会话的侧栏/菜单与最新放开状态一致。
      // (其他用户的浏览器仍需刷新/重登才生效 —— 无服务端推送,属已知限制。)
      void useAuth.getState().refreshAdminAccess();
      toast.success(t("admin.saved"));
    } catch (e) {
      toast.error((e as Error).message || t("error.saveFailed"));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        {t("admin.pageVis.desc")}
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {rows === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
        {rows?.map((row) => (
          <div key={row.key} className="flex items-center justify-between rounded-xl border border-line bg-white p-4 shadow-glass">
            <div className="text-sm font-medium text-fg">{row.label}</div>
            <div className="flex gap-1 rounded-lg bg-surface p-0.5 text-xs">
              {(["admin", "all"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={savingKey === row.key}
                  onClick={() => row.visibility !== v && void setVis(row.key, v)}
                  className={
                    "rounded-md px-3 py-1.5 transition disabled:opacity-50 " +
                    (row.visibility === v ? "bg-primary text-primary-fg" : "text-muted hover:text-fg")
                  }
                >
                  {v === "admin" ? t("admin.pageVis.adminOnly") : t("admin.pageVis.allMembers")}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
