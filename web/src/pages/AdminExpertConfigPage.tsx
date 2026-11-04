import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { ExpertConfigForm } from "@/components/experts/ExpertConfigForm";
import { useT } from "@/i18n";

// 管理端:逐个角色配置「专家设定」。左选角色,右用共用的 ExpertConfigForm 编辑。
export function AdminExpertConfigPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <Inner />;
}

function Inner() {
  const t = useT();
  const [roles, setRoles] = useState<{ id: string; name: string }[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    void api.admin.listRoles().then((r) => {
      setRoles(r.roles.map((x) => ({ id: x.id, name: x.name })));
      if (r.roles[0]) setSel(r.roles[0].id);
    }).catch(() => setRoles([]));
  }, []);

  const nameOf = (id: string) => roles?.find((r) => r.id === id)?.name ?? "";

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* 左:角色列表 */}
      <aside className="w-48 shrink-0 overflow-y-auto">
        <p className="mb-2 text-sm font-semibold text-fg">{t("admin.expertConfig.roles")}</p>
        {roles === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
        <div className="flex flex-col gap-1">
          {roles?.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSel(r.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition ${sel === r.id ? "bg-accent-soft font-semibold text-primary" : "text-muted hover:bg-blue-50/60"}`}
            >
              {r.name}
            </button>
          ))}
          {roles?.length === 0 && <p className="text-sm text-muted">{t("admin.expertConfig.noRoles")}</p>}
        </div>
      </aside>

      {/* 右:专家设定编辑 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!sel ? (
          <p className="text-sm text-muted">{t("admin.expertConfig.pick")}</p>
        ) : (
          <div className="max-w-2xl space-y-5">
            <h2 className="text-base font-semibold text-fg">{nameOf(sel)}{t("admin.expertConfig.titleSuffix")}</h2>
            <ExpertConfigForm roleId={sel} roleName={nameOf(sel)} />
          </div>
        )}
      </div>
    </div>
  );
}
