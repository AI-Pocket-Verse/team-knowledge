import { Navigate } from "react-router-dom";
import { useIsAdmin } from "@/stores/auth";
import { VolcSttSection, VolcTtsSection } from "./adminSettingsSections";
import { useT } from "@/i18n";

// 语音引擎(系统管理)。配置会议实时语音识别(STT)与语音合成(TTS)的火山引擎凭证。
// 原「系统设置 → 语音引擎」选项卡独立成页。Gate 在外层拦住非管理员,避免内部 admin-only
// 接口在重定向前先 403。
export function AdminVoiceEnginePage() {
  const t = useT();
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        {t("admin.voice.desc")}
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <VolcSttSection />
        <VolcTtsSection />
      </div>
    </div>
  );
}
