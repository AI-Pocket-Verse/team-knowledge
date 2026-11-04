import { useEffect, useState } from "react";
import { api, type WebNotifySettings } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT } from "@/i18n";

// 管理后台 → Web 通知。三类「事件完成」通知(自动化 / 会议纪要 /助手生图)的组织级
// 全局开关:关掉即全员不再产生该类通知(连站内铃铛都不写)。每位成员还能在右上角「通知铃铛
// → 通知设置」里各自关闭某类或整个浏览器桌面弹窗;浏览器授权则由各自浏览器控制。
// 访问门控由路由层 RequireAdminPage(pageKey="web-notify")负责:管理员,或该页已在
// 「页面可见性」放开给所有成员。不再自拦 isAdmin(否则放开后成员会被弹走)。
export function AdminWebNotifyPage() {
  return <Inner />;
}

const ROWS: { key: keyof Omit<WebNotifySettings, "enabled">; label: string; hint: string }[] = [
  { key: "automation", get label() { return tr("admin.webNotify.automation"); }, get hint() { return tr("admin.webNotify.automationHint"); } },
  { key: "meeting", get label() { return tr("admin.webNotify.meeting"); }, get hint() { return tr("admin.webNotify.meetingHint"); } },
  { key: "image", get label() { return tr("admin.webNotify.image", { name: getAssistantName() }); }, get hint() { return tr("admin.webNotify.imageHint", { name: getAssistantName() }); } },
];

function Inner() {
  const t = useT();
  const [settings, setSettings] = useState<WebNotifySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.adminSettings.webNotify.get().then(setSettings).catch((e) => toast.error((e as Error).message || t("error.loadFailed")));
  }, []);

  async function save(patch: Partial<WebNotifySettings>) {
    setSaving(true);
    // 乐观更新:先本地反映,失败再回滚到服务端权威值。
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      const next = await api.adminSettings.webNotify.set(patch);
      setSettings(next);
    } catch (e) {
      toast.error((e as Error).message || t("error.saveFailed"));
      api.adminSettings.webNotify.get().then(setSettings).catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <div className="w-full text-sm text-muted">{t("common.loading")}</div>;

  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        {t("admin.webNotify.desc", { name: getAssistantName() })}
      </p>

      {/* 总开关 */}
      <label className="mt-6 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-white p-4 shadow-glass">
        <span>
          <span className="block text-sm font-medium text-fg">{t("admin.webNotify.enable")}</span>
          <span className="mt-0.5 block text-xs text-muted">{t("admin.webNotify.enableHint")}</span>
        </span>
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={settings.enabled}
          disabled={saving}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
      </label>

      {/* 分类开关(总开关关闭时禁用) */}
      <div className={`mt-3 rounded-xl border border-line bg-white shadow-glass ${settings.enabled ? "" : "opacity-50"}`}>
        {ROWS.map((r, i) => (
          <label
            key={r.key}
            className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-3 ${i > 0 ? "border-t border-line" : ""} ${settings.enabled ? "" : "cursor-not-allowed"}`}
          >
            <span>
              <span className="block text-sm text-fg">{r.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{r.hint}</span>
            </span>
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={settings[r.key]}
              disabled={saving || !settings.enabled}
              onChange={(e) => void save({ [r.key]: e.target.checked })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
