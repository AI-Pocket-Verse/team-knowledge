import { useEffect, useState } from "react";
import { api, type WebNotifySettings } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { getAssistantName } from "@/lib/assistantName";

// 管理后台 → Web 通知。三类「事件完成」通知(自动化 / 会议纪要 /助手生图)的组织级
// 全局开关:关掉即全员不再产生该类通知(连站内铃铛都不写)。每位成员还能在右上角「通知铃铛
// → 通知设置」里各自关闭某类或整个浏览器桌面弹窗;浏览器授权则由各自浏览器控制。
// 访问门控由路由层 RequireAdminPage(pageKey="web-notify")负责:管理员,或该页已在
// 「页面可见性」放开给所有成员。不再自拦 isAdmin(否则放开后成员会被弹走)。
export function AdminWebNotifyPage() {
  return <Inner />;
}

const ROWS: { key: keyof Omit<WebNotifySettings, "enabled">; label: string; hint: string }[] = [
  { key: "automation", label: "自动化任务完成", hint: "定时/手动运行的自动化任务跑完时提醒发起人" },
  { key: "meeting", label: "会议纪要生成", hint: "会议结束、纪要生成完成时提醒主持人" },
  { key: "image", get label() { return `${getAssistantName()} 生成图片`; }, get hint() { return `在对话里让 ${getAssistantName()} 画图,生成完成时提醒本人`; } },
];

function Inner() {
  const [settings, setSettings] = useState<WebNotifySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.adminSettings.webNotify.get().then(setSettings).catch((e) => toast.error((e as Error).message || "加载失败"));
  }, []);

  async function save(patch: Partial<WebNotifySettings>) {
    setSaving(true);
    // 乐观更新:先本地反映,失败再回滚到服务端权威值。
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      const next = await api.adminSettings.webNotify.set(patch);
      setSettings(next);
    } catch (e) {
      toast.error((e as Error).message || "保存失败");
      api.adminSettings.webNotify.get().then(setSettings).catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <div className="w-full text-sm text-muted">加载中…</div>;

  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        浏览器桌面通知:自动化、会议纪要、{getAssistantName()} 生图等异步任务完成时,给发起人弹一条系统通知,
        并在站内「通知铃铛」留一条记录。此处为组织级总开关;成员可在「通知铃铛 → 通知设置」里
        各自关闭某类或整个桌面弹窗。
      </p>

      {/* 总开关 */}
      <label className="mt-6 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-white p-4 shadow-glass">
        <span>
          <span className="block text-sm font-medium text-fg">启用 Web 通知</span>
          <span className="mt-0.5 block text-xs text-muted">关闭后,下面三类通知全部停止(站内铃铛也不再写入)。</span>
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
