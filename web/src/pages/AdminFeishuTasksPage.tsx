import { Navigate } from "react-router-dom";
import { useIsAdmin } from "@/stores/auth";
import { FeishuTasksConsole } from "./adminSettingsSections";

// 「飞书群任务」管理页(系统管理)。原是 系统设置 里的一个 tab,现独立成页。控制台组件
// (FeishuTasksConsole,自带标题/说明/保存/逐场景配置)定义在 adminSettingsSections 区块库、
// 此处直接复用;这里只做管理员守卫 + 容器。Gate 在外层就拦住非管理员,避免内部的
// admin-only 接口在重定向前先 403。
export function AdminFeishuTasksPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return (
    <div className="w-full">
      <FeishuTasksConsole />
    </div>
  );
}
