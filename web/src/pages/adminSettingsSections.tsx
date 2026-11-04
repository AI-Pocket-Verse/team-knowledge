// 系统管理各「设置区块」的可复用组件库。原「系统设置」单页(带左侧 AI / 语音 /
// GitHub 选项卡)已拆成 AI 提供方 / 语音引擎 / GitHub 仓库 三个独立页面
//(AdminAiProviderPage / AdminVoiceEnginePage / AdminGithubPage),各自直接渲染下面
// 对应的区块组件;「飞书群任务」页(AdminFeishuTasksPage)复用 FeishuTasksConsole。
import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmBinarySettings, LlmModelSettings } from "@team-knowledge/shared";
import { api, type GithubRepoView, type NotifyTestScenario, type NotifyTestSendResult, type NotifyTestCronSchedule, type ArticleReviewSettings } from "@/lib/api";
import { parseGithubRepo } from "@/lib/githubUrl";
import { dialog } from "@/components/Dialog";
import { toast } from "@/components/Toaster";
import { TimePicker } from "@/components/automation/Select";
import { cn } from "@/lib/cn";
import { getAssistantName } from "@/lib/assistantName";
import { useT, type MessageKey } from "@/i18n";

const WEEKDAY_KEYS: MessageKey[] = ["admin.ft.wd.1", "admin.ft.wd.2", "admin.ft.wd.3", "admin.ft.wd.4", "admin.ft.wd.5", "admin.ft.wd.6", "admin.ft.wd.7"];
const WEEKDAY_ARIA_KEYS: MessageKey[] = ["admin.ft.wda.1", "admin.ft.wda.2", "admin.ft.wda.3", "admin.ft.wda.4", "admin.ft.wda.5", "admin.ft.wda.6", "admin.ft.wda.7"];

// ─── GitHub 仓库配置 ──────────────────────────────────────────
// 周五周报「研发改动」段统计这里配置的仓库本周提交(不含本项目)。token 只写不读
// (后端掩码),私有仓库填只读 PAT。每行可「测试连接」验证真的能拉到信息。
export function GithubReposSection() {
  const t = useT();
  const [repos, setRepos] = useState<GithubRepoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"token" | "ssh">("token");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [rowTest, setRowTest] = useState<Record<string, string>>({});
  // 分支选择面板:当前展开的仓库 id、远端分支列表缓存、面板内的勾选草稿。
  const [branchPanel, setBranchPanel] = useState<string | null>(null);
  const [branchList, setBranchList] = useState<Record<string, string[]>>({});
  const [branchSel, setBranchSel] = useState<Record<string, string[]>>({});
  const [branchLoading, setBranchLoading] = useState<string | null>(null);
  const [branchSaving, setBranchSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setRepos((await api.admin.github.list()).repos);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    const parsed = parseGithubRepo(url);
    if (!parsed) { toast.error(t("admin.gh.badUrl")); return; }
    if (busy) return;
    setBusy(true);
    try {
      await api.admin.github.add({ owner: parsed.owner, repo: parsed.repo, auth, token: auth === "token" ? token.trim() || undefined : undefined });
      setUrl(""); setToken(""); setAuth("token"); setTestMsg(null);
      await load();
      toast.success(t("admin.gh.added"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testForm() {
    const parsed = parseGithubRepo(url);
    if (!parsed) { setTestMsg({ kind: "err", text: t("admin.gh.badUrl") }); return; }
    setBusy(true); setTestMsg(null);
    try {
      const r = await api.admin.github.test({ owner: parsed.owner, repo: parsed.repo, auth, token: auth === "token" ? token.trim() || undefined : undefined });
      setTestMsg({ kind: "ok", text: t("admin.gh.connected", { name: r.fullName, detail: r.detail }) });
    } catch (e) {
      setTestMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function testSaved(id: string) {
    setRowTest((m) => ({ ...m, [id]: t("admin.gh.testing") }));
    try {
      const r = await api.admin.github.testSaved(id);
      setRowTest((m) => ({ ...m, [id]: t("admin.gh.connectedRow", { name: r.fullName, detail: r.detail }) }));
    } catch (e) {
      setRowTest((m) => ({ ...m, [id]: `✗ ${(e as Error).message}` }));
    }
  }

  async function remove(r: GithubRepoView) {
    const ok = await dialog.confirm(t("admin.gh.deleteMsg", { label: r.label }), { title: t("admin.gh.deleteTitle"), confirmText: t("common.delete"), danger: true });
    if (!ok) return;
    try { await api.admin.github.remove(r.id); await load(); toast.success(t("admin.backup.deleted")); } catch (e) { toast.error((e as Error).message); }
  }

  // 展开/收起某仓库的分支面板;首次展开时拉取远端分支列表(SSH/Token 按存储认证)。
  async function openBranches(r: GithubRepoView) {
    if (branchPanel === r.id) { setBranchPanel(null); return; }
    setBranchPanel(r.id);
    if (!branchList[r.id]) {
      setBranchLoading(r.id);
      try {
        const { branches, selected } = await api.admin.github.branches(r.id);
        setBranchList((m) => ({ ...m, [r.id]: branches }));
        setBranchSel((m) => ({ ...m, [r.id]: selected }));
      } catch (e) {
        toast.error(t("admin.gh.branchesFailed", { msg: (e as Error).message }));
        setBranchPanel(null);
      } finally {
        setBranchLoading(null);
      }
    }
  }

  function toggleBranch(repoId: string, name: string) {
    setBranchSel((m) => {
      const cur = m[repoId] ?? [];
      return { ...m, [repoId]: cur.includes(name) ? cur.filter((b) => b !== name) : [...cur, name] };
    });
  }

  async function saveBranches(r: GithubRepoView) {
    setBranchSaving(r.id);
    try {
      const sel = branchSel[r.id] ?? [];
      await api.admin.github.updateBranches(r.id, sel);
      await load();
      toast.success(sel.length > 0 ? t("admin.gh.branchesSaved", { n: sel.length }) : t("admin.gh.branchesAll"));
      setBranchPanel(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBranchSaving(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        {/* 标题只在右区顶栏(RightTopBar),页面本体不重复。 */}
        <p className="text-xs text-muted">
          {t("admin.gh.desc1")}
          <b>SSH</b>{t("admin.gh.desc2")}
          <b>API Token</b>{t("admin.gh.desc3")}
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-muted">{t("common.loading")}</div>
      ) : loadError ? (
        <div className="flex items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <span>{t("admin.gh.loadFailed", { msg: loadError })}</span>
          <button type="button" onClick={() => void load()} className="shrink-0 rounded-lg border border-rose-300 px-2 py-1 text-xs transition hover:bg-rose-100">
            {t("common.retry")}
          </button>
        </div>
      ) : repos.length === 0 ? (
        <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("admin.gh.empty")}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {repos.map((r) => (
            <div key={r.id} className="rounded-lg border border-line bg-white p-3 transition hover:border-line hover:shadow-glass">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.label}</div>
                  <div className="truncate text-xs text-muted">
                    {r.owner}/{r.repo} · {r.auth === "ssh" ? t("admin.gh.sshKey") : r.hasToken ? "API token" : t("admin.gh.apiPublic")}
                    {t("admin.gh.branchLabel")}{r.branches.length === 0 ? t("admin.gh.all") : r.branches.join(t("common.listSep"))}
                    {rowTest[r.id] ? ` · ${rowTest[r.id]}` : ""}
                  </div>
                </div>
                <button type="button" onClick={() => void openBranches(r)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-muted transition hover:border-primary/50 hover:text-primary">
                  {branchPanel === r.id ? t("admin.gh.hideBranches") : t("admin.gh.pickBranches")}
                </button>
                <button type="button" onClick={() => void testSaved(r.id)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-muted transition hover:border-primary/50 hover:text-primary">
                  {t("admin.gh.test")}
                </button>
                <button type="button" onClick={() => void remove(r)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-rose-600 transition hover:bg-rose-50">
                  {t("common.delete")}
                </button>
              </div>

              {/* 分支选择面板:勾选 = 周报只统计这些分支;一个不勾 = 统计全部分支 */}
              {branchPanel === r.id && (
                <div className="mt-3 rounded-lg border border-line bg-surface p-3">
                  {branchLoading === r.id ? (
                    <div className="text-xs text-muted">{t("admin.gh.fetching")}</div>
                  ) : (
                    <>
                      <div className="flex max-h-40 flex-wrap content-start gap-x-4 gap-y-1.5 overflow-auto text-xs">
                        {(branchList[r.id] ?? []).map((b) => (
                          <label key={b} className="flex cursor-pointer items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={(branchSel[r.id] ?? []).includes(b)}
                              onChange={() => toggleBranch(r.id, b)}
                              className="accent-primary"
                            />
                            <span className="font-mono">{b}</span>
                          </label>
                        ))}
                        {(branchList[r.id] ?? []).length === 0 && <span className="text-muted">{t("admin.gh.noBranches")}</span>}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={branchSaving === r.id}
                          onClick={() => void saveBranches(r)}
                          className="rounded-lg bg-primary px-3 py-1 text-xs text-primary-fg transition disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {branchSaving === r.id ? t("common.saving") : t("common.save")}
                        </button>
                        <button
                          type="button"
                          disabled={branchSaving === r.id}
                          onClick={() => setBranchSel((m) => ({ ...m, [r.id]: [] }))}
                          className="rounded-lg border border-line px-3 py-1 text-xs text-muted transition hover:border-primary/50 hover:text-primary"
                        >
                          {t("admin.gh.clear")}
                        </button>
                        <span className="text-xs text-muted">
                          {(branchSel[r.id] ?? []).length > 0
                            ? t("admin.gh.selected", { n: (branchSel[r.id] ?? []).length })
                            : t("admin.gh.noneSelected")}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
        <div className="text-sm font-medium">{t("admin.gh.addTitle")}</div>
        <input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setTestMsg(null); }}
          placeholder={t("admin.gh.urlPlaceholder")}
          className="mt-3 w-full rounded-lg border border-line px-2 py-1.5 text-sm"
        />
        {/* 认证方式 */}
        <div className="mt-2 flex items-center gap-4 text-sm">
          <span className="text-muted">{t("admin.gh.authMode")}</span>
          {([
            { v: "ssh", label: t("admin.gh.authSsh") },
            { v: "token", label: "API Token" },
          ] as const).map((o) => (
            <label key={o.v} className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" name="gh-auth" checked={auth === o.v} onChange={() => { setAuth(o.v); setTestMsg(null); }} className="accent-primary" />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        {auth === "token" && (
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("admin.gh.tokenPlaceholder")} type="password" autoComplete="off" className="mt-2 w-full rounded-lg border border-line px-2 py-1.5 text-sm" />
        )}
        {auth === "ssh" && (
          <p className="mt-2 text-xs text-muted">{t("admin.gh.sshHint")}</p>
        )}
        {testMsg && <div className={`mt-2 text-xs ${testMsg.kind === "ok" ? "text-emerald-700" : "text-rose-700"}`}>{testMsg.text}</div>}
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={!url.trim() || busy} onClick={() => void testForm()} className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:border-primary/50 hover:text-primary disabled:opacity-50">
            {busy ? t("admin.gh.wait") : t("admin.gh.test")}
          </button>
          <button type="button" disabled={!url.trim() || busy} onClick={() => void add()} className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:opacity-50">
            {t("admin.gh.add")}
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── 飞书群任务(自动任务控制台) ─────────────────────────────
// 独立成页(系统管理 → 飞书群任务,见 AdminFeishuTasksPage)后由该页渲染;仍定义在此
// 文件以避免大块迁移。
// 每个发往飞书群聊的通知任务一张卡片:① 勾选目标群(多选,默认全选)② 开/关
// 自动任务(定时 cron / 事件触发)③ 定时类任务的触发时刻。所有改动先落在本地
// 草稿,点右上角「保存」逐场景 PATCH 后统一生效(成功/失败 toast 提示);
// 「发送测试」不走草稿,按服务端已保存的配置立即手动发一条(与自动任务开关
// 无关)。配置存服务端 Setting 表,dev/prod 各自独立。

// 「文档体检」检测参数(强度评级 + 每类最多显示条数)。独立本地 state,不进
// FeishuTasksConsole 的草稿/差异机制;挂载时载入,「保存检测参数」单独 PUT。
function DocAuditTuningPanel() {
  const t = useT();
  const [strength, setStrength] = useState<number | "">(4);
  const [maxPerCategory, setMaxPerCategory] = useState<number | "">(10);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const t = await api.adminSettings.docAuditTuning.get();
        setStrength(t.strength);
        setMaxPerCategory(t.maxPerCategory);
      } catch {
        // 载入失败保持默认值,不打扰用户。
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = async () => {
    // 空/非法夹到合法范围与默认(strength 1-10、maxPerCategory ≥1)。
    const s = typeof strength === "number" && Number.isFinite(strength)
      ? Math.min(10, Math.max(1, Math.floor(strength)))
      : 4;
    const m = typeof maxPerCategory === "number" && Number.isFinite(maxPerCategory)
      ? Math.max(1, Math.floor(maxPerCategory))
      : 10;
    setSaving(true);
    try {
      const next = await api.adminSettings.docAuditTuning.set({ strength: s, maxPerCategory: m });
      setStrength(next.strength);
      setMaxPerCategory(next.maxPerCategory);
      toast.success(t("admin.da.saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface p-3">
      <div className="text-xs font-medium">{t("admin.da.title")}</div>
      <p className="mt-1 text-[11px] text-muted">
        {t("admin.da.desc")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-muted">{t("admin.da.strength")}</span>
          <input
            type="number"
            min={1}
            max={10}
            value={strength}
            disabled={!loaded}
            onChange={(e) => setStrength(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-20 rounded-lg border border-line bg-white px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">{t("admin.da.maxPer")}</span>
          <input
            type="number"
            min={1}
            value={maxPerCategory}
            disabled={!loaded}
            onChange={(e) => setMaxPerCategory(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-24 rounded-lg border border-line bg-white px-2 py-1"
          />
        </label>
        <button
          type="button"
          disabled={!loaded || saving}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-1 text-primary-fg transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("admin.da.save")}
        </button>
      </div>
    </div>
  );
}

export function FeishuTasksConsole() {
  const t = useT();
  const [scenarios, setScenariosState] = useState<NotifyTestScenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 发送按任务粒度互斥(一个任务发送中不挡其它任务)。
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  // scenarios(本地草稿)的同步权威镜像:连续快速勾选时,下一次 toggle 要基于
  // 「上一次点击后」的状态算 next,而 state 闭包/useEffect 镜像都可能滞后一拍。
  const scenariosRef = useRef<NotifyTestScenario[]>([]);
  // 服务端已保存状态的基线(按 key):草稿与基线的差集 = 点「保存」要提交的
  // 内容。load 时整体重建,保存成功后逐场景推进。
  const baselineRef = useRef<Record<string, NotifyTestScenario>>({});
  const [saving, setSaving] = useState(false);

  const setScenarios = useCallback((updater: (list: NotifyTestScenario[]) => NotifyTestScenario[]) => {
    scenariosRef.current = updater(scenariosRef.current);
    setScenariosState(scenariosRef.current);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { scenarios: list } = await api.admin.notifyTest.list();
      baselineRef.current = Object.fromEntries(list.map((s) => [s.key, s]));
      setScenarios(() => list);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setScenarios]);
  useEffect(() => { void load(); }, [load]);

  // 运行状态轮询(5s):定时任务/发送测试执行中时,场景行显示「运行中」动画。
  // 只合并 running 字段 —— 整列表替换会踩掉未保存的草稿改动。
  useEffect(() => {
    const t = window.setInterval(async () => {
      try {
        const { scenarios: list } = await api.admin.notifyTest.list();
        const runningByKey = new Map(list.map((x) => [x.key, x.running]));
        setScenarios((cur) => cur.map((s) => ({ ...s, running: runningByKey.get(s.key) ?? s.running })));
      } catch { /* 轮询失败忽略,下一轮再试 */ }
    }, 5000);
    return () => window.clearInterval(t);
  }, [setScenarios]);

  function summarize(results: NotifyTestSendResult[]): { ok: boolean; text: string } {
    const ok = results.every((r) => r.ok);
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const head = ok ? t("admin.ft.sent", { n: okCount }) : t("admin.ft.partial", { ok: okCount, total: results.length });
    const detail = failed.length ? t("admin.ft.failedList", { list: failed.map((f) => `${f.name}(${f.error})`).join(t("common.listSep")) }) : "";
    return { ok, text: head + detail };
  }

  // 发送 = 异步任务:POST 拿 jobId(立即返回),轮询直到完成。周报/文档体检要跑
  // LLM,可能要几分钟 —— 轮询上限 5 分钟,超时提示稍后直接看群。
  async function send(key: string) {
    if (sending[key]) return;
    setSending((m) => ({ ...m, [key]: true }));
    setResult((m) => { const { [key]: _omit, ...rest } = m; return rest; });
    try {
      const { jobId } = await api.admin.notifyTest.send(key);
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await api.admin.notifyTest.sendStatus(jobId);
        if (st.status === "done") {
          setResult((m) => ({
            ...m,
            [key]: st.error ? { ok: false, text: st.error } : summarize(st.results ?? []),
          }));
          break;
        }
        if (Date.now() > deadline) {
          setResult((m) => ({ ...m, [key]: { ok: true, text: t("admin.ft.stillRunning") } }));
          break;
        }
      }
    } catch (e) {
      setResult((m) => ({ ...m, [key]: { ok: false, text: (e as Error).message } }));
    } finally {
      setSending((m) => ({ ...m, [key]: false }));
    }
  }

  // ── 本地草稿编辑:改动只更新草稿,点右上角「保存」统一提交 ──
  function updateDraft(key: string, partial: Partial<NotifyTestScenario>) {
    setScenarios((list) => list.map((s) => (s.key === key ? { ...s, ...partial } : s)));
  }

  function toggleEnabled(key: string, enabled: boolean) {
    updateDraft(key, { enabled });
  }

  function toggleChat(key: string, chatId: string) {
    // 基于权威镜像(含前面所有草稿改动)计算,快速连点也不会用过期勾选集。
    const cur = scenariosRef.current.find((s) => s.key === key)?.selected ?? [];
    const next = cur.includes(chatId) ? cur.filter((id) => id !== chatId) : [...cur, chatId];
    updateDraft(key, { selected: next });
  }

  // ── 草稿与基线的差异(= 待保存内容)──
  function sameStrSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sb = [...b].sort();
    return [...a].sort().every((v, i) => v === sb[i]);
  }
  function sameSchedule(a: NotifyTestCronSchedule, b: NotifyTestCronSchedule): boolean {
    return (
      a.hour === b.hour && a.minute === b.minute && a.repeat === b.repeat &&
      a.weekdays.length === b.weekdays.length && a.weekdays.every((d, i) => d === b.weekdays[i])
    );
  }
  function diffOf(s: NotifyTestScenario): { enabled?: boolean; chatIds?: string[]; schedule?: NotifyTestCronSchedule } | null {
    const base = baselineRef.current[s.key];
    if (!base) return null;
    const body: { enabled?: boolean; chatIds?: string[]; schedule?: NotifyTestCronSchedule } = {};
    if (s.enabled !== base.enabled) body.enabled = s.enabled;
    if (!sameStrSet(s.selected, base.selected)) body.chatIds = s.selected;
    if (s.cronSchedule && base.cronSchedule && !sameSchedule(s.cronSchedule, base.cronSchedule)) {
      body.schedule = s.cronSchedule;
    }
    return Object.keys(body).length ? body : null;
  }
  // 渲染期由草稿 state 重算;基线只在 load/保存成功时变,且都伴随 setScenarios,
  // 所以 ref 不触发渲染也不会读到过期 dirty。
  const dirtyKeys = new Set(scenarios.filter((s) => diffOf(s) !== null).map((s) => s.key));

  // 逐场景提交差异(服务端 PATCH 落库并即时重排定时器)。全部成功 toast 成功;
  // 失败的场景基线不推进、草稿保留,修正后可直接重试。
  async function saveAll() {
    if (saving) return;
    const changes = scenariosRef.current
      .map((s) => ({ key: s.key, title: s.title, body: diffOf(s) }))
      .filter((c): c is { key: string; title: string; body: NonNullable<ReturnType<typeof diffOf>> } => c.body !== null);
    if (changes.length === 0) return;
    setSaving(true);
    const failed: string[] = [];
    for (const c of changes) {
      try {
        const { scenario } = await api.admin.notifyTest.update(c.key, c.body);
        // 只推进基线到服务端权威态(= 已落库值);草稿不回写 —— 否则会覆盖用户在 PATCH
        // 往返期间对同一场景的在途编辑,也会把 save 时点的 running 带进草稿盖掉 5s 轮询的
        // 实时值。weekdays 客户端已保持升序(toggleWeekday),与服务端去重排序一致,基线
        // 推进后干净保存的草稿不会被误判为 dirty;「未保存」徽标随 setSaving 重渲染清除。
        baselineRef.current[c.key] = { ...baselineRef.current[c.key], ...scenario };
      } catch (e) {
        failed.push(t("admin.ft.itemFail", { title: c.title, msg: (e as Error).message }));
      }
    }
    setSaving(false);
    if (failed.length === 0) toast.success(t("admin.ft.saveOk"));
    else toast.error(t("admin.ft.saveFail", { n: failed.length, total: changes.length, list: failed.join(t("admin.ft.sep")) }));
  }

  // ── 定时类任务的触发时刻编辑(星期多选 / 时:分 / 是否每周重复)──
  // 与服务端 formatCronSchedule 同一套文案,用于草稿编辑时即时刷新时刻描述。
  function cronText(s: NotifyTestCronSchedule): string {
    const days =
      s.weekdays.length === 7 ? t("admin.ft.everyDay")
      : s.weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => s.weekdays.includes(d)) ? t("admin.ft.workdays")
      : t("admin.ft.weekly", { days: s.weekdays.map((d) => t(WEEKDAY_KEYS[d - 1])).join(t("common.listSep")) });
    const hh = String(s.hour).padStart(2, "0");
    const mm = String(s.minute).padStart(2, "0");
    return t("admin.ft.cron", { days, time: `${hh}:${mm}`, once: s.repeat ? "" : t("admin.ft.cronOnce") });
  }
  function patchSchedule(key: string, next: NotifyTestCronSchedule) {
    updateDraft(key, { cronSchedule: next, schedule: cronText(next) });
  }
  function curSchedule(key: string): NotifyTestCronSchedule | null {
    return scenariosRef.current.find((s) => s.key === key)?.cronSchedule ?? null;
  }
  function toggleWeekday(key: string, day: number) {
    const cur = curSchedule(key);
    if (!cur) return;
    const has = cur.weekdays.includes(day);
    if (has && cur.weekdays.length === 1) {
      toast.error(t("admin.ft.minOneDay"));
      return;
    }
    const weekdays = has ? cur.weekdays.filter((d) => d !== day) : [...cur.weekdays, day].sort((a, b) => a - b);
    patchSchedule(key, { ...cur, weekdays });
  }
  function changeTime(key: string, hhmm: string) {
    const cur = curSchedule(key);
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!cur || !m) return; // 输入中途的不完整值由 <input type="time"> 自行兜住
    patchSchedule(key, { ...cur, hour: Number(m[1]), minute: Number(m[2]) });
  }
  function changeRepeat(key: string, repeat: boolean) {
    const cur = curSchedule(key);
    if (cur) patchSchedule(key, { ...cur, repeat });
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          {/* 标题只在右区顶栏(RightTopBar),页面本体不重复。 */}
          <p className="text-xs text-muted">
            {t("admin.ft.desc")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirtyKeys.size > 0 && !saving && <span className="text-xs text-amber-700">{t("admin.ft.dirty")}</span>}
          <button
            type="button"
            disabled={saving || dirtyKeys.size === 0}
            onClick={() => void saveAll()}
            className="rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      {scenarios.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">{t("admin.ft.jump")}</span>
          {scenarios.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-label={t("admin.ft.jumpTo", { title: s.title })}
              onClick={() => document.getElementById(`notify-scenario-${s.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="rounded-full border border-line bg-white px-2.5 py-1 text-xs text-fg/80 transition hover:bg-accent-soft hover:text-accent"
            >
              {s.title}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted">{t("common.loading")}</div>
      ) : loadError ? (
        <div className="flex items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <span>{t("admin.gh.loadFailed", { msg: loadError })}</span>
          <button type="button" onClick={() => void load()} className="shrink-0 rounded-lg border border-rose-300 px-2 py-1 text-xs transition hover:bg-rose-100">
            {t("common.retry")}
          </button>
        </div>
      ) : scenarios.length === 0 ? (
        <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("admin.ft.empty")}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {scenarios.map((s) => {
            const r = result[s.key];
            return (
              <div key={s.key} id={`notify-scenario-${s.key}`} className="scroll-mt-20 rounded-xl border border-line bg-white p-4 shadow-glass">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{s.title}</span>
                      {s.running && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-normal text-primary">
                          <span aria-hidden className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-primary/30 border-t-primary" />
                          {t("admin.ft.running")}
                        </span>
                      )}
                      {dirtyKeys.has(s.key) && (
                        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] font-normal text-amber-700">{t("admin.ft.unsaved")}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">{s.description}</p>

                    {/* 自动任务开关 + 触发时机(草稿,点「保存」后生效) */}
                    <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) => toggleEnabled(s.key, e.target.checked)}
                        className="accent-primary"
                      />
                      <span className="font-medium">{t("admin.ft.autoOn")}</span>
                      <span className={s.enabled ? "text-muted" : "text-muted line-through"}>{s.schedule}</span>
                      {!s.enabled && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">{t("admin.ft.disabled")}</span>}
                    </label>

                    {/* 定时类任务:触发时刻编辑(星期多选 + 时:分 + 是否每周重复),
                        保存后服务端即时重排下一次触发。 */}
                    {s.cronSchedule && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted">{t("admin.ft.triggerTime")}</span>
                        <div className="flex items-center gap-1" role="group" aria-label={t("admin.ft.pickDays")}>
                          {WEEKDAY_KEYS.map((nameKey, i) => {
                            const name = t(nameKey);
                            const day = i + 1;
                            const on = s.cronSchedule!.weekdays.includes(day);
                            return (
                              <button
                                key={day}
                                type="button"
                                aria-pressed={on}
                                aria-label={t(WEEKDAY_ARIA_KEYS[i])}
                                onClick={() => toggleWeekday(s.key, day)}
                                className={
                                  "h-6 w-6 rounded-full text-[11px] leading-none transition " +
                                  (on
                                    ? "bg-primary text-primary-fg"
                                    : "border border-line bg-white text-muted hover:border-primary/50 hover:text-primary")
                                }
                              >
                                {name}
                              </button>
                            );
                          })}
                        </div>
                        <input
                          type="time"
                          aria-label={t("admin.ft.timeAria")}
                          value={`${String(s.cronSchedule.hour).padStart(2, "0")}:${String(s.cronSchedule.minute).padStart(2, "0")}`}
                          onChange={(e) => changeTime(s.key, e.target.value)}
                          className="rounded-lg border border-line bg-white px-1.5 py-0.5"
                        />
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={s.cronSchedule.repeat}
                            onChange={(e) => changeRepeat(s.key, e.target.checked)}
                            className="accent-primary"
                          />
                          {t("admin.ft.repeat")}
                        </label>
                        {!s.cronSchedule.repeat && (
                          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">{t("admin.ft.once")}</span>
                        )}
                      </div>
                    )}

                    {/* 目标群多选(草稿,点「保存」后生效) */}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      <span className="text-muted">{t("admin.ft.targets")}</span>
                      {s.available.map((t) => (
                        <label key={t.chatId} className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={s.selected.includes(t.chatId)}
                            onChange={() => toggleChat(s.key, t.chatId)}
                            className="accent-primary"
                          />
                          <span>{t.name}</span>
                        </label>
                      ))}
                      {s.selected.length === 0 && <span className="text-amber-700">{t("admin.ft.noTargets")}</span>}
                    </div>

                    {/* 文档体检:额外的「检测参数」小块(独立本地 state,不进草稿)。 */}
                    {s.key === "doc_audit" && <DocAuditTuningPanel />}

                    {r && <div className={`mt-2 text-xs ${r.ok ? "text-emerald-700" : "text-rose-700"}`}>{r.text}</div>}
                  </div>
                  <button
                    type="button"
                    disabled={s.selected.length === 0 || !!sending[s.key]}
                    onClick={() => void send(s.key)}
                    className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sending[s.key] ? t("admin.ft.sending") : t("admin.ft.sendTest")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ─── 火山 STT credentials section ────────────────────────
// Renders a form bound to GET /api/admin/settings/volc-stt. The
// accessToken is rendered as a placeholder (masked echo of the
// stored secret); leaving it blank on save preserves the old token.
export function VolcSttSection() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creds, setCreds] = useState<{
    configured: boolean;
    appId: string | null;
    accessToken: string | null;
    apiKey: string | null;
    endpoint: string | null;
    resourceId: string | null;
    model: string | null;
    boostingTableId: string | null;
  } | null>(null);
  const [draft, setDraft] = useState({
    apiKey: "",
    appId: "",
    accessToken: "",
    endpoint: "",
    resourceId: "",
    model: "",
    boostingTableId: "",
  });
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const c = await api.adminSettings.getVolcStt();
      setCreds(c);
      setDraft({
        apiKey: c.apiKey ?? "",
        appId: c.appId ?? "",
        accessToken: c.accessToken ?? "",
        endpoint: c.endpoint ?? "",
        resourceId: c.resourceId ?? "",
        model: c.model ?? "",
        boostingTableId: c.boostingTableId ?? "",
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.adminSettings.saveVolcStt({
        apiKey: draft.apiKey,
        appId: draft.appId,
        accessToken: draft.accessToken,
        endpoint: draft.endpoint || null,
        resourceId: draft.resourceId || null,
        model: draft.model || null,
        boostingTableId: draft.boostingTableId || null,
      });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    const ok = await dialog.confirm(t("admin.volc.sttClearMsg"), {
      title: t("admin.volc.sttClearTitle"),
      confirmText: t("admin.volc.clear"),
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    setErr(null);
    try {
      await api.adminSettings.clearVolcStt();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("common.loading")}</div>;
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center gap-3">
        <span className="text-base font-medium text-fg">{t("admin.volc.sttTitle")}</span>
        {creds?.configured ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">{t("admin.volc.configured")}</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">{t("admin.volc.sttNone")}</span>
        )}
      </div>
      {err && (
        <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted sm:col-span-2">
          {t("admin.volc.apiKey")}
          <input
            type="text"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={t("admin.volc.apiKeyPh")}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-muted/80">
            {t("admin.volc.keyHint")}
          </span>
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.appId")}
          <input
            value={draft.appId}
            onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.accessToken")}
          <input
            type="text"
            value={draft.accessToken}
            onChange={(e) => setDraft({ ...draft, accessToken: e.target.value })}
            placeholder={t("admin.volc.unset")}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.endpoint")}
          <input
            value={draft.endpoint}
            onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
            placeholder="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.resourceId")}
          <input
            value={draft.resourceId}
            onChange={(e) => setDraft({ ...draft, resourceId: e.target.value })}
            placeholder="volc.bigasr.sauc.duration"
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.model")}
          <input
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            placeholder="bigmodel"
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-muted/80">
            {t("admin.volc.modelHint")}
          </span>
        </label>
      </div>
      <label className="mt-3 block text-xs text-muted">
        {t("admin.volc.boost")}
        <input
          value={draft.boostingTableId}
          onChange={(e) => setDraft({ ...draft, boostingTableId: e.target.value })}
          placeholder={t("admin.volc.boostPh")}
          className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
        />
        <span className="mt-1 block text-[11px] leading-relaxed text-muted/80">
          {t("admin.volc.boostHint")}
        </span>
      </label>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={saving || !(draft.apiKey || (draft.appId && draft.accessToken))}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {creds?.configured && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void clear()}
            className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
          >
            {t("admin.volc.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── CLI 可执行文件路径(claude / codex)────────────────────
// 服务以 systemd 运行时 PATH 很精简(不含 nvm 等用户级目录),spawn 裸命令
// "claude"/"codex" 会 ENOENT,上面的探测显示红色 ✗。在此填绝对路径
// (如 /root/.nvm/versions/node/v20.20.2/bin/claude)即可修复。留空=清除,
// 回退到 .env 的 CLAUDE_BIN/CODEX_BIN 或 PATH。保存后即时重新探测。
export function LlmBinariesSection({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<LlmBinarySettings | null>(null);
  const [draft, setDraft] = useState({ claudePath: "", codexPath: "" });
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const d = await api.adminSettings.getLlmBinaries();
      setData(d);
      setDraft({ claudePath: d.claudePath ?? "", codexPath: d.codexPath ?? "" });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      // 空串 → null = 清除该路径(回退 env/PATH)。
      const d = await api.adminSettings.setLlmBinaries({
        claudePath: draft.claudePath.trim() || null,
        codexPath: draft.codexPath.trim() || null,
      });
      setData(d);
      setDraft({ claudePath: d.claudePath ?? "", codexPath: d.codexPath ?? "" });
      onSaved();  // 让左侧 provider 探测状态一并刷新(✗ → ✓)
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("common.loading")}</div>;
  }

  const rows = [
    { key: "claudePath" as const, label: t("admin.bin.claude"), probe: data?.available.claude, ph: "/root/.nvm/versions/node/v20.20.2/bin/claude" },
    { key: "codexPath" as const, label: t("admin.bin.codex"), probe: data?.available.codex, ph: "/root/.nvm/versions/node/v20.20.2/bin/codex" },
  ];

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center gap-2">
        <span className="text-base font-medium text-fg">{t("admin.bin.title")}</span>
        <span className="text-xs text-muted">{t("admin.bin.desc")}</span>
      </div>
      {err && (
        <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
      )}
      <div className="mt-4 flex flex-col gap-3">
        {rows.map((r) => (
          <label key={r.key} className="text-xs text-muted">
            <span className="flex items-center gap-2">
              {r.label}
              {r.probe && (r.probe.ok
                ? <span className="text-emerald-700">✓ {t("admin.ai.ready")} {r.probe.version ? `(${r.probe.version})` : ""}</span>
                : <span className="text-rose-700">✗ {r.probe.reason ?? t("admin.ai.notReady")}</span>)}
            </span>
            <input
              value={draft[r.key]}
              onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
              placeholder={r.ph}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-sm"
            />
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted"
        >
          {saving ? t("admin.bin.saving") : t("admin.bin.save")}
        </button>
        <span className="text-xs text-muted">{t("admin.bin.clearHint")}</span>
      </div>
    </div>
  );
}

// ─── 各引擎使用的模型 ────────────────────────
// 样式与「命令路径」一致。留空 = 回退 .env 的 CLAUDE_MODEL / CODEX_MODEL，再留空用 CLI 默认模型。
// 候选只是输入提示，可以手填任意模型 ID(格式由服务端校验)。
const CLAUDE_MODEL_SUGGESTIONS = ["fable", "opus", "sonnet", "haiku"];

export function LlmModelsSection() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<LlmModelSettings | null>(null);
  const [draft, setDraft] = useState({ claude: "", codex: "" });
  const [err, setErr] = useState<string | null>(null);

  function apply(d: LlmModelSettings) {
    setData(d);
    setDraft({ claude: d.claude ?? "", codex: d.codex ?? "" });
  }

  useEffect(() => {
    api.adminSettings.getLlmModels()
      .then(apply)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      // 空串 → null = 清除该引擎的模型(回退 .env / CLI 默认)。
      apply(await api.adminSettings.setLlmModels({
        claude: draft.claude.trim() || null,
        codex: draft.codex.trim() || null,
      }));
      toast.success(t("admin.models.saved"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("common.loading")}</div>;
  }

  const rows = [
    { key: "claude" as const, label: t("admin.models.claude"), ph: t("admin.models.claudePh"), list: "llm-model-claude" },
    { key: "codex" as const, label: t("admin.models.codex"), ph: t("admin.models.codexPh"), list: undefined },
  ];

  return (
    <div data-testid="llm-models-section" className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center gap-2">
        <span className="text-base font-medium text-fg">{t("admin.models.title")}</span>
        <span className="text-xs text-muted">{t("admin.models.desc")}</span>
      </div>
      {err && (
        <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
      )}
      <div className="mt-4 flex flex-col gap-3">
        {rows.map((r) => {
          const envDefault = data?.envDefault[r.key];
          const active = data?.active[r.key];
          return (
            <label key={r.key} className="text-xs text-muted">
              <span className="flex items-center gap-2">
                {r.label}
                <span>{t("admin.models.active")}<span className="text-fg">{active ?? t("admin.models.cliDefault")}</span></span>
              </span>
              <input
                value={draft[r.key]}
                onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
                placeholder={envDefault ? t("admin.models.envPh", { model: envDefault }) : r.ph}
                list={r.list}
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-sm"
              />
            </label>
          );
        })}
        <datalist id="llm-model-claude">
          {CLAUDE_MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
        </datalist>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        <span className="text-xs text-muted">{t("admin.models.clearHint")}</span>
      </div>
    </div>
  );
}

// ─── 火山 TTS credentials section ────────────────────────
export function VolcTtsSection() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creds, setCreds] = useState<{
    configured: boolean;
    appId: string | null;
    accessToken: string | null;
    apiKey: string | null;
    voice: string | null;
    endpoint: string | null;
  } | null>(null);
  const [draft, setDraft] = useState({ apiKey: "", appId: "", accessToken: "", voice: "", endpoint: "" });
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const c = await api.adminSettings.getVolcTts();
      setCreds(c);
      setDraft({
        apiKey: c.apiKey ?? "",
        appId: c.appId ?? "",
        accessToken: c.accessToken ?? "",
        voice: c.voice ?? "",
        endpoint: c.endpoint ?? "",
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.adminSettings.saveVolcTts({
        apiKey: draft.apiKey,
        appId: draft.appId,
        accessToken: draft.accessToken,
        voice: draft.voice || null,
        endpoint: draft.endpoint || null,
      });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    const ok = await dialog.confirm(t("admin.volc.ttsClearMsg"), {
      title: t("admin.volc.ttsClearTitle"),
      confirmText: t("admin.volc.clear"),
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    setErr(null);
    try {
      await api.adminSettings.clearVolcTts();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("common.loading")}</div>;
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center gap-3">
        <span className="text-base font-medium text-fg">{t("admin.volc.ttsTitle")}</span>
        {creds?.configured ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">{t("admin.volc.configured")}</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">{t("admin.volc.ttsNone")}</span>
        )}
      </div>
      {err && (
        <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted sm:col-span-2">
          {t("admin.volc.apiKey")}
          <input
            type="text"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={t("admin.volc.apiKeyPh")}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-muted/80">
            {t("admin.volc.keyHint")}
          </span>
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.appId")}
          <input
            value={draft.appId}
            onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.accessToken")}
          <input
            type="text"
            value={draft.accessToken}
            onChange={(e) => setDraft({ ...draft, accessToken: e.target.value })}
            placeholder={t("admin.volc.unset")}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.voice")}
          <input
            value={draft.voice}
            onChange={(e) => setDraft({ ...draft, voice: e.target.value })}
            placeholder={t("admin.volc.voicePh")}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          {t("admin.volc.endpoint")}
          <input
            value={draft.endpoint}
            onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={saving || !(draft.apiKey || (draft.appId && draft.accessToken))}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {creds?.configured && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void clear()}
            className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
          >
            {t("admin.volc.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 文档 AI 入库前置校验总开关 ──────────────────────────────
// 开启后,文档最后一次编辑静置 10 分钟会由 AI 校验单篇质量与跨文档一致性,有问题则
// 提醒最后编辑者。被「助手内容过滤」排除的文档不参与。默认关闭。
export function ArticleReviewToggle() {
  const t = useT();
  const [settings, setSettings] = useState<ArticleReviewSettings | null>(null);
  const [intervalSec, setIntervalSec] = useState("");  // 扫描间隔(秒)输入草稿
  const [idleMin, setIdleMin] = useState("");          // 静置阈值(分钟)输入草稿
  const [saving, setSaving] = useState(false);

  function apply(s: ArticleReviewSettings) {
    setSettings(s);
    setIntervalSec(String(s.scanIntervalSec));
    setIdleMin(String(s.idleMinutes));
  }

  useEffect(() => {
    void api.adminSettings.articleReview.get().then(apply).catch(() => { /* 保持空白 */ });
  }, []);

  async function save(patch: Partial<ArticleReviewSettings>) {
    setSaving(true);
    try {
      const next = await api.adminSettings.articleReview.set(patch);
      setSettings(next);
      // 仅当本次就是在改「间隔/静置」时才回填其文本草稿;调其它项(严重度/提醒)不冲掉用户未保存的草稿。
      if (patch.scanIntervalSec !== undefined || patch.idleMinutes !== undefined) {
        setIntervalSec(String(next.scanIntervalSec));
        setIdleMin(String(next.idleMinutes));
      }
      toast.success(t("admin.saved"));
    } catch (e) {
      toast.error((e as Error).message || t("error.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const loading = settings === null;

  return (
    <section className="rounded-xl border border-line p-4">
      <h3 className="mb-1 text-sm font-semibold text-fg">{t("admin.ar.title")}</h3>
      <p className="mb-3 text-xs text-muted">
        {t("admin.ar.desc", { name: getAssistantName() })}
      </p>

      <label className="mb-3 inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!settings?.enabled}
          disabled={loading || saving}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>{settings?.enabled ? t("admin.ar.on") : t("admin.ar.off")}</span>
      </label>

      <div className="mb-3 flex flex-col gap-1 text-xs text-muted">
        {t("admin.ar.level")}
        <select
          value={settings?.minSeverity ?? "med"}
          disabled={loading || saving}
          onChange={(e) => void save({ minSeverity: e.target.value as ArticleReviewSettings["minSeverity"] })}
          className="w-56 rounded-lg border border-line px-2 py-1 text-sm text-fg"
        >
          <option value="low">{t("admin.ar.lvLow")}</option>
          <option value="med">{t("admin.ar.lvMed")}</option>
          <option value="high">{t("admin.ar.lvHigh")}</option>
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("admin.ar.scan")}
          <input
            type="number" min={30} max={3600} value={intervalSec}
            disabled={loading || saving}
            onChange={(e) => setIntervalSec(e.target.value)}
            className="w-32 rounded-lg border border-line px-2 py-1 text-sm text-fg"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("admin.ar.idle")}
          <input
            type="number" min={1} max={1440} value={idleMin}
            disabled={loading || saving}
            onChange={(e) => setIdleMin(e.target.value)}
            className="w-32 rounded-lg border border-line px-2 py-1 text-sm text-fg"
          />
        </label>
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => void save({ scanIntervalSec: Number(intervalSec), idleMinutes: Number(idleMin) })}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("admin.ar.saveInterval")}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted">{t("admin.ar.clampNote")}</p>

      {/* ─── 每日复检提醒 ─── */}
      <div className="mt-4 border-t border-line pt-4">
        <h4 className="mb-1 text-sm font-semibold text-fg">{t("admin.ar.reminderTitle")}</h4>
        <p className="mb-3 text-xs text-muted">
          {t("admin.ar.reminderDesc")}
        </p>
        <label className="mb-3 inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!settings?.reminderEnabled}
            disabled={loading || saving}
            onChange={(e) => void save({ reminderEnabled: e.target.checked })}
          />
          <span>{settings?.reminderEnabled ? t("admin.ar.on") : t("admin.ar.off")}</span>
        </label>
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex flex-col gap-1.5 text-xs text-muted">
            {t("admin.ar.reminderDays")}
            <div className="flex gap-1">
              {REMINDER_WD.map((d) => {
                const on = settings?.reminderWeekdays?.includes(d.v) ?? false;
                return (
                  <button
                    key={d.v}
                    type="button"
                    disabled={loading || saving}
                    onClick={() => {
                      const cur = settings?.reminderWeekdays ?? [];
                      const next = on ? cur.filter((x) => x !== d.v) : [...cur, d.v].sort((a, b) => a - b);
                      void save({ reminderWeekdays: next });
                    }}
                    className={cn("h-8 w-8 rounded-md border text-sm transition disabled:opacity-50",
                      on ? "border-primary bg-accent-soft font-medium text-primary" : "border-line text-muted hover:bg-surface")}
                  >{t(WEEKDAY_KEYS[d.v - 1])}</button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5 text-xs text-muted">
            {t("admin.ar.reminderTime")}
            <TimePicker
              value={`${String(settings?.reminderHour ?? 10).padStart(2, "0")}:${String(settings?.reminderMinute ?? 0).padStart(2, "0")}`}
              onChange={(v) => { const [h, m] = v.split(":").map(Number); void save({ reminderHour: h, reminderMinute: m }); }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

const REMINDER_WD = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ v }));
