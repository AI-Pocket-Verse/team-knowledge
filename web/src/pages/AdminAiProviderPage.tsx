import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import type { LlmProviderStatus } from "@team-knowledge/shared";
import { api, ApiError, type ModelDisplayAdmin } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { LlmBinariesSection, LlmModelsSection } from "./adminSettingsSections";
import { toast } from "@/components/Toaster";

type Status = LlmProviderStatus;

// AI 提供方(系统管理)。为 问答 / 会议 / 群聊答疑 / 文档体检 选择底层 AI 引擎,并在
// PATH 找不到 claude/codex 时配置可执行文件绝对路径。原「系统设置 → AI 提供方」选项卡
// 独立成页。Gate 在外层就拦住非管理员,避免内部 admin-only 接口在重定向前先 403。
export function AdminAiProviderPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <AdminAiProviderPageInner />;
}

function AdminAiProviderPageInner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [errStatus, setErrStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setErr(null);
    setErrStatus(null);
    setLoading(true);
    try {
      const s = await api.adminSettings.getLlmProvider();
      setStatus(s);
    } catch (e) {
      setErr((e as Error).message);
      if (e instanceof ApiError) setErrStatus(e.status);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function switchTo(name: "claude" | "codex") {
    setBusy(true);
    setErr(null);
    setErrStatus(null);
    try {
      const s = await api.adminSettings.setLlmProvider({ provider: name });
      setStatus(s);
    } catch (e) {
      setErr((e as Error).message);
      if (e instanceof ApiError) setErrStatus(e.status);
    } finally {
      setBusy(false);
    }
  }

  // First load failed with no status to show → dedicated empty-state card.
  if (!status && !loading && err) {
    const isOffline = errStatus === 0;
    return (
      <div className="max-w-2xl">
        <div className="mt-6 rounded-xl border border-line bg-white p-8 text-center shadow-glass">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-500">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isOffline ? (
                <>
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                  <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                  <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
                  <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                  <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                  <line x1="12" y1="20" x2="12.01" y2="20" />
                </>
              ) : (
                <>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </>
              )}
            </svg>
          </div>
          <h2 className="text-base font-semibold text-fg">
            {isOffline ? "服务暂不可用" : "无法加载设置"}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {isOffline
              ? "无法连接到后端服务，请确认 API 正在运行后重试。"
              : err}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted"
          >
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        选择 问答 / 会议 / 群聊答疑 / 文档体检 使用的底层 AI 引擎和模型。切换会立即对新发起的对话生效;正在流式输出的旧对话不会被打断。
      </p>

      {err && (
        <div className="mt-4 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      <section className="mt-6 flex flex-col gap-3">
        {(["claude", "codex"] as const).map((name) => {
          if (!status) return null;
          const probe = status.available[name];
          const isCurrent = status.current === name;
          const label = name === "claude" ? "Claude Code" : "Codex";
          // 与服务端 codexAllowed() 同一真值：多人模式下切 codex 会被 409 拒绝，按钮直接禁用并说明原因。
          const blocked = name === "codex" && !status.codexAllowed;
          return (
            <div key={name} data-testid={`provider-row-${name}`} className="rounded-xl border border-line bg-white p-4 shadow-glass">
              <div className="flex items-center gap-3">
                <span className="text-base font-medium text-fg">{label}</span>
                {isCurrent && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-primary">当前</span>
                )}
                {probe.ok ? (
                  <span className="text-xs text-emerald-600">
                    ✓ 已就绪 {probe.version ? `(${probe.version})` : ""}
                  </span>
                ) : (
                  <span className="text-xs text-rose-600">✗ {probe.reason ?? "未就绪"}</span>
                )}
              </div>
              {!isCurrent && (
                <button
                  type="button"
                  disabled={!probe.ok || busy || blocked}
                  onClick={() => void switchTo(name)}
                  className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted"
                >
                  切换为 {label}
                </button>
              )}
              {blocked && (
                <p className="mt-2 text-xs text-muted">
                  已启用登录的多人部署只能使用 Claude Code：Codex 带 shell 工具，无法限制它读取服务器文件。
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="self-start text-xs text-muted underline hover:text-primary disabled:opacity-50"
        >
          刷新探测
        </button>

        {/* 各引擎使用的模型(后台设置 > .env > CLI 默认)。 */}
        <LlmModelsSection />

        {/* 命令路径:服务以 systemd 运行时 PATH 精简,找不到 nvm 里的 claude/codex
            会报红 ✗。在此填绝对路径即可修复。 */}
        <LlmBinariesSection onSaved={() => void refresh()} />

        {/* 对外显示的模型型号(手填 curated + 探测核对)。 */}
        <ModelDisplaySection />
      </section>
    </div>
  );
}

// 对外显示的「模型型号」:每 provider 手填 模型+版本+等级(飞书卡片/Skill 卡片都以它为准),
// 旁边只读展示「实际检测到」的真实模型供核对;末尾一个「群答疑卡片是否显示模型」开关。
function ModelDisplaySection() {
  const [cfg, setCfg] = useState<ModelDisplayAdmin | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.adminSettings.getModelDisplay().then(setCfg).catch((e) => toast.error((e as Error).message || "加载失败"));
  }, []);

  function setField(provider: "claude" | "codex", key: "model" | "version" | "level", v: string) {
    setCfg((c) => (c ? { ...c, [provider]: { ...c[provider], [key]: v } } : c));
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      const next = await api.adminSettings.setModelDisplay({ claude: cfg.claude, codex: cfg.codex, showInGroupCard: cfg.showInGroupCard });
      setCfg(next);
      toast.success("已保存模型型号");
    } catch (e) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">加载模型型号设置…</div>;

  const providers: { key: "claude" | "codex"; label: string }[] = [
    { key: "claude", label: "Claude Code" },
    { key: "codex", label: "Codex" },
  ];
  const preview = (p: "claude" | "codex") => {
    const f = cfg[p];
    const parts = [f.model, f.version, f.level].map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts.join(" ") : (p === "claude" ? "Claude Code" : "Codex");
  };

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">对外显示的模型型号</div>
          <div className="mt-0.5 text-xs text-muted">飞书群答疑卡片 / 角色 Skill 卡片对外展示的模型名,以这里手填的为准(格式:模型 · 版本 · 等级)。三段留空则显示上面的默认名。</div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {providers.map(({ key, label }) => (
          <div key={key} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-fg">{label}</span>
              {cfg.detected[key] ? (
                <span className="text-[11px] text-muted" title="从 CLI 对话流探测到的真实模型,供核对手填是否一致">实际检测到:<span className="text-fg">{cfg.detected[key]}</span></span>
              ) : (
                <span className="text-[11px] text-muted">实际检测到:—(尚无 / 该引擎不上报)</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {([["model", "模型"], ["version", "版本"], ["level", "等级"]] as const).map(([k, ph]) => (
                <input
                  key={k}
                  value={cfg[key][k]}
                  disabled={saving}
                  placeholder={ph}
                  onChange={(e) => setField(key, k, e.target.value)}
                  className="w-full rounded-lg border border-line bg-white px-2 py-1 text-sm"
                />
              ))}
            </div>
            <div className="mt-2 text-[11px] text-muted">对外显示:<span className="text-fg">{preview(key)}</span></div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs font-medium text-fg">群答疑卡片显示模型</span>
        <div className="flex gap-1.5">
          {[{ v: true, label: "显示" }, { v: false, label: "不显示" }].map((o) => {
            const on = cfg.showInGroupCard === o.v;
            return (
              <button
                key={String(o.v)}
                type="button"
                disabled={saving}
                onClick={() => setCfg((c) => (c ? { ...c, showInGroupCard: o.v } : c))}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${on ? "bg-primary text-white" : "border border-line bg-white text-fg hover:bg-surface"}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-muted">默认不显示,避免群里噪音;Skill 卡片始终显示。</span>
      </div>
    </div>
  );
}
