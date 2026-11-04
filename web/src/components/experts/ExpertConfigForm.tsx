import { useEffect, useRef, useState } from "react";
import { api, uploadSrc, type ExpertConfig, type RoleMember } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { UserPicker } from "./UserPicker";

const SOURCE_LABELS: { key: keyof ExpertConfig["sources"]; label: string; hint: string }[] = [
  { key: "kbDocs", label: "知识库文档", hint: "全库共享,所有专家可读" },
  { key: "crossModule", label: "会议纪要 / 群答疑", hint: "内部跨模块检索" },
  { key: "webSearch", label: "联网搜索", hint: "让模型自己联网(按量计费)" },
  { key: "consult", label: "允许被请教", hint: "其他专家可向它请教" },
];

// 专家设定表单(管理整页 + 专家卡弹窗共用)。自包含读写:按 roleId 加载/保存。
// 负责人 = 该角色「默认转交目标」:选人默认列角色成员,也可按名搜任意用户。
export function ExpertConfigForm({ roleId, roleName }: { roleId: string; roleName?: string }) {
  const [cfg, setCfg] = useState<ExpertConfig | null>(null);
  const [members, setMembers] = useState<RoleMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  // 上传头像:走通用图片上传(/uploads/image),拿到 /uploads/<file> 后只更新本地 cfg,
  // 由「保存」一并持久化(与其它字段同口径)。
  async function pickAvatar(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setUploadingAvatar(true);
    try {
      const { url } = await api.uploads.image(f);
      setCfg((c) => (c ? { ...c, avatarUrl: url } : c));
    } catch (e) {
      toast.error((e as Error).message || "头像上传失败");
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  useEffect(() => {
    setCfg(null);
    void api.adminExperts.get(roleId).then(setCfg).catch(() => setCfg(null));
    void api.roles.members(roleId).then((r) => setMembers(r.members)).catch(() => setMembers([]));
  }, [roleId]);

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      const next = await api.adminExperts.set(cfg.roleId, {
        instruction: cfg.instruction,
        ownerUserId: cfg.ownerUserId,
        avatarUrl: cfg.avatarUrl,
        enabled: cfg.enabled,
        sources: cfg.sources,
      });
      setCfg(next);
      toast.success("已保存");
    } catch (e) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) return <p className="text-sm text-muted">加载中…</p>;
  const ownerLabel = cfg.ownerUserId ? (members.find((m) => m.userId === cfg.ownerUserId)?.displayName ?? cfg.ownerUserId) : null;

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <span>{cfg.enabled ? "已启用(出现在专家列表、可被分诊)" : "已停用"}</span>
      </label>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg">头像</label>
        <div className="flex items-center gap-3">
          {cfg.avatarUrl ? (
            <img src={uploadSrc(cfg.avatarUrl)} alt="专家头像" className="h-12 w-12 rounded-full border border-line object-cover" />
          ) : (
            <span className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-base font-semibold text-white">
              {(roleName ?? "专").trim().slice(0, 1) || "专"}
            </span>
          )}
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => void pickAvatar(e.target.files)}
          />
          <button
            type="button"
            disabled={uploadingAvatar}
            onClick={() => avatarInputRef.current?.click()}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-fg transition hover:bg-surface disabled:opacity-50"
          >
            {uploadingAvatar ? "上传中…" : "上传头像"}
          </button>
          {cfg.avatarUrl && (
            <button
              type="button"
              onClick={() => setCfg({ ...cfg, avatarUrl: null })}
              className="rounded-lg px-2 py-1.5 text-sm text-muted transition hover:text-fg"
            >
              移除
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">不上传则用角色名首字渐变底色占位。改动后点下方「保存」生效。</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg">专家设定(人设 / 职责 / 风格)</label>
        <textarea
          className="h-40 w-full rounded-lg border border-line p-3 text-sm text-fg"
          placeholder={`例:你是「${roleName ?? "该角色"}」专家,负责…;风格简洁、先给结论。留空则用默认人设。`}
          value={cfg.instruction}
          onChange={(e) => setCfg({ ...cfg, instruction: e.target.value })}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg">默认负责人(升级时的默认转交目标)</label>
        {cfg.ownerUserId ? (
          // 已选 → 标签样式 + 右上角叉号删除;删除后回到选人控件。
          <span className="relative mt-1 inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-sm text-primary">
            {ownerLabel}
            <button
              type="button"
              title="移除负责人"
              onClick={() => setCfg({ ...cfg, ownerUserId: null })}
              className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-[10px] leading-none text-primary-fg shadow hover:opacity-90"
            >
              ×
            </button>
          </span>
        ) : (
          <div className="w-72">
            <UserPicker suggestions={members} value={null} onChange={(uid) => setCfg({ ...cfg, ownerUserId: uid })} />
          </div>
        )}
      </div>

      <div>
        <p className="mb-1 text-sm font-medium text-fg">知识来源</p>
        <div className="flex flex-col gap-2">
          {SOURCE_LABELS.map((s) => (
            <label key={s.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={cfg.sources[s.key]}
                onChange={(e) => setCfg({ ...cfg, sources: { ...cfg.sources, [s.key]: e.target.checked } })}
              />
              <span className="text-fg">{s.label}</span>
              <span className="text-xs text-muted">— {s.hint}</span>
            </label>
          ))}
        </div>
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-fg transition hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
