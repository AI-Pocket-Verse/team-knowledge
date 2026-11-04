import { Navigate } from "react-router-dom";
import { useIsAdmin } from "@/stores/auth";
import { GithubReposSection } from "./adminSettingsSections";
import { useT } from "@/i18n";

// GitHub 仓库(系统管理)。配置周报「研发改动」段统计的代码仓库。原「系统设置 →
// GitHub 仓库」选项卡独立成页。Gate 在外层拦住非管理员,避免内部 admin-only 接口在
// 重定向前先 403。
export function AdminGithubPage() {
  const t = useT();
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        {t("admin.github.desc")}
      </p>
      <div className="mt-6">
        <GithubReposSection />
      </div>
    </div>
  );
}
