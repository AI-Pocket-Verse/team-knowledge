import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { DelayedLoader } from "@/components/DelayedLoader";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { tr, useT } from "@/i18n";

// 飞书式新建:进入即在服务端创建空文档,replace 跳到统一文档页(带 justCreated
// 让目标页自动进入编辑、光标待命)。空内容因 hasRetrievableContent 兜底不进检索。
export function NewArticleRedirect() {
  const t = useT();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode / 重渲染下只建一次
    ran.current = true;
    const roleId = sp.get("roleId");
    const folderId = sp.get("folderId");
    if (!roleId) { setError(tr("workspace.newDoc.missingRole")); return; }
    api.articles
      .create({ roleId, folderId: folderId ?? null, title: "", contentMarkdown: "" })
      .then((r) => {
        requestRoleRefresh(roleId);
        nav(`/d/${r.article.id}`, { replace: true, state: { justCreated: true } });
      })
      .catch((e) => setError((e as Error).message));
  }, [sp, nav, requestRoleRefresh]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 p-10">
        <div className="text-red-600">{t("workspace.newDoc.failed", { error })}</div>
        <Link to="/" className="text-sm text-primary hover:underline">{t("workspace.newDoc.back")}</Link>
      </div>
    );
  }
  return <DelayedLoader label={t("workspace.newDoc.creating")} />;
}
