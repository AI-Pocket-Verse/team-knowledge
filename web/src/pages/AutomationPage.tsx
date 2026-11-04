import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Automation, type AutomationListResponse, type AutomationInput, type AutomationTemplate, type AutomationRunDetail, type AutomationRun } from "@/lib/api";
import { AutomationForm, type AutomationFormValue } from "@/components/automation/AutomationForm";
import { AutomationTemplates } from "@/components/automation/AutomationTemplates";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { BackButton } from "@/components/ui/BackButton";
import { formatTimestamp } from "@/lib/format";
import type { UiChatMessage } from "@/stores/chat";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { usePageChrome } from "@/stores/pageChrome";
import { useAiSurface } from "@/stores/aiSurface";
import { cn } from "@/lib/cn";

// 相对时间:未来「N后」、过去「N前」。
function relTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} 分钟`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} 小时`
    : `${Math.round(abs / 86_400_000)} 天`;
  return diff >= 0 ? `${unit}后` : `${unit}前`;
}
// 展示 slug:automation-<北京创建时刻>(还原截图里的灰色芯片)。
function slug(iso: string): string {
  const b = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `automation-${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}-${p(b.getUTCHours())}-${p(b.getUTCMinutes())}-${p(b.getUTCSeconds())}`;
}

type View = { t: "list" } | { t: "templates" } | { t: "add"; prefill?: AutomationFormValue } | { t: "edit"; id: string } | { t: "run"; runId: string };

export function AutomationPage() {
  const [data, setData] = useState<AutomationListResponse | null>(null);
  const [view, setView] = useState<View>({ t: "list" });
  const [editing, setEditing] = useState<Automation | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refetch = useCallback(async () => {
    try { setData(await api.automations.list()); } catch { toast.error("加载失败,请刷新重试"); }
  }, []);
  // 每次回到列表(首次进入、从添加/编辑/详情返回)都刷新一次 —— 让刚触发的「执行中」状态即时显示。
  useEffect(() => { if (view.t === "list") void refetch(); }, [view.t, refetch]);

  // 有运行中的任务时轮询刷新,让「执行中」→「已完成」自动流转(测试运行/定时触发都覆盖)。
  useEffect(() => {
    if (!data?.recentRuns.some((r) => r.status === "running")) return;
    const t = setInterval(() => void refetch(), 5000);
    return () => clearInterval(t);
  }, [data, refetch]);

  // 进入编辑:拉完整任务。
  useEffect(() => {
    if (view.t !== "edit") { setEditing(null); return; }
    let cancelled = false;
    void api.automations.get(view.id).then((a) => { if (!cancelled) setEditing(a); }).catch(() => { if (!cancelled) { toast.error("任务不存在"); setView({ t: "list" }); } });
    return () => { cancelled = true; };
  }, [view]);

  async function save(input: AutomationInput) {
    setSubmitting(true);
    try {
      if (view.t === "edit") { await api.automations.update(view.id, input); toast.success("已保存"); }
      else { await api.automations.create(input); toast.success("已创建"); }
      await refetch();
      setView({ t: "list" });
    } catch (e) { toast.error((e as Error).message || "保存失败"); }
    finally { setSubmitting(false); }
  }

  // 页面标题「自动化」只在右区顶栏出现(飞书式:标题不重复);页面级动作(添加/从
  // 模板添加)登记到顶栏右侧。运行详情是二级页面,自带返回 + 任务名,不再出这两个动作。
  usePageChrome({
    rightActions: view.t === "run" ? undefined : (
      <>
        <button type="button" onClick={() => setView({ t: "add" })} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-surface">＋ 添加</button>
        <button type="button" onClick={() => setView({ t: "templates" })} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-surface">从模板添加</button>
      </>
    ),
  });

  if (!data) return <div className="p-2 text-sm text-muted">加载中…</div>;

  // 运行详情 = 二级页面:独立展示(自带返回 + 任务名标题),不叠加主页标题 → 全页「只有一个标题」。
  if (view.t === "run") return <RunDetailView runId={view.runId} onBack={() => setView({ t: "list" })} />;

  const templatesOpen = view.t === "templates";
  const formOpen = view.t === "add" || view.t === "edit";

  return (
    <div>
      <AutomationList
        data={data}
        onOpen={(id) => setView({ t: "edit", id })}
        onOpenRun={(runId) => setView({ t: "run", runId })}
        onToggle={async (a) => {
          try {
            if (a.enabled) await api.automations.pause(a.id); else await api.automations.resume(a.id);
            toast.success(a.enabled ? "已暂停" : "已启用");
            await refetch();
          } catch (e) { toast.error((e as Error).message || "操作失败"); }
        }}
      />

      {/* 从模板添加:弹窗 */}
      <Dialog open={templatesOpen} onOpenChange={(o) => { if (!o) setView({ t: "list" }); }}>
        {templatesOpen && (
          <DialogContent className="flex max-h-[85vh] w-[560px] max-w-[94vw] flex-col overflow-y-auto">
            <div className="flex items-center justify-between">
              <DialogTitle>从模板添加</DialogTitle>
              <DialogClose className="rounded-md px-1.5 text-lg leading-none text-muted transition hover:text-fg" aria-label="关闭">✕</DialogClose>
            </div>
            <AutomationTemplates
              templates={data.templates}
              onPick={(t: AutomationTemplate) => setView({ t: "add", prefill: { name: t.title, prompt: t.prompt, scheduleKind: t.scheduleKind, scheduleConfig: t.scheduleConfig } })}
            />
          </DialogContent>
        )}
      </Dialog>

      {/* 添加 / 编辑:弹窗(标题常驻顶部、按钮常驻底部、中间滚动) */}
      <Dialog open={formOpen} onOpenChange={(o) => { if (!o) setView({ t: "list" }); }}>
        {formOpen && (
          <DialogContent
            // 自定义下拉菜单 portal 到 body(带 data-automation-menu),点它不应关闭弹窗。
            onPointerDownOutside={(e) => { if ((e.target as Element)?.closest?.("[data-automation-menu]")) e.preventDefault(); }}
            onInteractOutside={(e) => { if ((e.target as Element)?.closest?.("[data-automation-menu]")) e.preventDefault(); }}
            className="flex max-h-[85vh] w-[640px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0"
          >
            {view.t === "add" ? (
              <>
                <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
                  <DialogTitle>添加自动化任务</DialogTitle>
                  <DialogClose className="rounded-md px-1.5 text-lg leading-none text-muted transition hover:text-fg" aria-label="关闭">✕</DialogClose>
                </div>
                <AutomationForm initial={view.prefill} onSubmit={save} onCancel={() => setView({ t: "list" })} submitting={submitting} />
              </>
            ) : editing ? (
              <>
                <div className="shrink-0 border-b border-line px-6 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <DialogTitle>编辑自动化任务</DialogTitle>
                    <DialogClose className="rounded-md px-1.5 text-lg leading-none text-muted transition hover:text-fg" aria-label="关闭">✕</DialogClose>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    创建于 {new Date(editing.createdAt).toLocaleDateString()} · {editing.runCount} 次运行 ·{" "}
                    <span className={editing.enabled ? "text-emerald-600" : "text-muted"}>{editing.enabled ? "● 运行中" : "❚❚ 已暂停"}</span>
                  </p>
                </div>
                <AutomationForm
                  initial={editing} onSubmit={save} onCancel={() => setView({ t: "list" })} submitting={submitting}
                  leftActions={<EditActions a={editing} onChanged={refetch} onDeleted={() => { void refetch(); setView({ t: "list" }); }} onRan={() => { setView({ t: "list" }); void refetch(); }} onLocal={setEditing} />}
                />
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted">加载中…</p>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function AutomationList({ data, onOpen, onOpenRun, onToggle }: {
  data: AutomationListResponse;
  onOpen: (id: string) => void;
  onOpenRun: (runId: string) => void;
  onToggle: (a: Automation) => void;
}) {
  const scheduled = data.automations;
  const runningRuns = data.recentRuns.filter((r) => r.status === "running");
  const doneRuns = data.recentRuns.filter((r) => r.status !== "running");

  // 「已完成」按所属自动化任务分组:每个任务一项。折叠时只显示最新 1 条,展开/加载更多按任务分页
  //(见 CompletedTaskGroup)。这里只需每个任务的「最新一条 + 元信息」;更早记录由子组件按需拉取。
  // 排序:置顶(pinnedAt desc)优先,其次按该任务最近一次运行时间 desc。
  const autoById = useMemo(() => new Map(data.automations.map((a) => [a.id, a])), [data.automations]);
  const doneGroups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; pinnedAt: string | null; latest: AutomationRun; latestMs: number }>();
    for (const r of doneRuns) {
      const ms = new Date(r.finishedAt ?? r.startedAt).getTime();
      const g = m.get(r.automationId);
      if (!g) { const a = autoById.get(r.automationId); m.set(r.automationId, { id: r.automationId, name: a?.name ?? r.automationName, pinnedAt: a?.pinnedAt ?? null, latest: r, latestMs: ms }); }
      else if (ms > g.latestMs) { g.latest = r; g.latestMs = ms; }
    }
    return [...m.values()].sort((x, y) => {
      if (!!x.pinnedAt !== !!y.pinnedAt) return x.pinnedAt ? -1 : 1;               // 置顶优先
      if (x.pinnedAt && y.pinnedAt) { const d = new Date(y.pinnedAt).getTime() - new Date(x.pinnedAt).getTime(); if (d) return d; }
      return y.latestMs - x.latestMs;                                              // 再按最近运行
    });
  }, [doneRuns, autoById]);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted">已安排</h2>
        {scheduled.length === 0 ? <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">还没有自动化任务,点右上角「添加」创建。</div> : (
          <div className="flex flex-col">
            {scheduled.map((a) => {
              // 一次性任务跑完(已 disable 且有过正式运行)= 已结束终态,不再显示暂停/启用。
              const doneOnce = a.scheduleKind === "once" && !a.enabled && !!a.lastRunStatus;
              const statusLabel = !a.enabled ? (doneOnce ? "已结束" : "已暂停") : a.nextRunAt ? `${relTime(a.nextRunAt)}开始` : "已结束";
              return (
                <div key={a.id} className="group flex items-center gap-3 rounded-lg px-2 py-3 transition hover:bg-surface">
                  <button type="button" onClick={() => onOpen(a.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", a.enabled ? "bg-fg/70" : "bg-line")} />
                    <span className="shrink-0 font-semibold text-fg">{a.name}</span>
                    <Chip>{slug(a.createdAt)}</Chip>
                    <Chip>{a.scheduleLabel}</Chip>
                  </button>
                  <span className="shrink-0 text-sm text-muted">{statusLabel}</span>
                  {!doneOnce && (
                    <button type="button" onClick={() => onToggle(a)} title={a.enabled ? "暂停" : "启用"}
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-primary opacity-0 transition hover:bg-primary/10 group-hover:opacity-100">
                      {a.enabled ? "暂停" : "启用"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {runningRuns.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted">执行中</h2>
          <div className="flex flex-col">
            {runningRuns.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-lg bg-surface/60 px-2 py-3">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-fg" />
                <span className="shrink-0 font-semibold text-fg">{r.automationName}</span>
                <Chip>{slug(r.startedAt)}</Chip>
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  <span className="text-sm text-muted">运行中</span>
                  <button type="button" onClick={() => onOpenRun(r.id)}
                    className="rounded-lg border border-line px-3 py-1 text-sm text-fg transition hover:bg-surface">查看运行详情</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted">已完成</h2>
        {doneGroups.length === 0 ? <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">暂无运行记录。</div> : (
          <div className="flex flex-col gap-1">
            {doneGroups.map((g) => (
              <CompletedTaskGroup key={g.id} group={g} onOpenRun={onOpenRun} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 truncate rounded-md bg-line/50 px-2 py-0.5 text-xs text-muted max-w-[220px]">{children}</span>;
}

// 「已完成」里的单个任务项:折叠时只显示最新 1 条;点折叠按钮展开、按任务分页拉取(每次 5 条)。
function CompletedTaskGroup({ group, onOpenRun }: {
  group: { id: string; name: string; pinnedAt: string | null; latest: AutomationRun };
  onOpenRun: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null); // null=未拉取(折叠时用 latest)
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  async function loadFirst() {
    setLoading(true);
    try { const res = await api.automations.taskRuns(group.id, undefined, 5); setRuns(res.runs); setHasMore(res.hasMore); }
    catch { toast.error("加载失败,请重试"); }
    finally { setLoading(false); }
  }
  async function loadMore() {
    const cur = runs?.[runs.length - 1]?.id;
    if (!cur) return;
    setLoading(true);
    try { const res = await api.automations.taskRuns(group.id, cur, 5); setRuns((prev) => [...(prev ?? []), ...res.runs]); setHasMore(res.hasMore); }
    catch { toast.error("加载失败,请重试"); }
    finally { setLoading(false); }
  }
  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && runs === null) void loadFirst();
  }

  // 折叠态展开态共用的「单条运行状态」渲染:圆点 + 文案 + 时间 + ✓/✗,点击进运行详情。
  const runRow = (r: AutomationRun, opts?: { compact?: boolean }) => {
    const ok = r.status === "success";
    const label = ok ? (r.isTest ? "测试运行完成" : "运行完成") : (r.error ? `失败:${r.error.slice(0, 40)}` : "运行失败");
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); onOpenRun(r.id); }}
        className={cn("flex items-center gap-3 rounded-lg text-left transition hover:bg-surface", opts?.compact ? "px-2 py-1" : "w-full px-2 py-2.5")}>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", ok ? "bg-emerald-500" : "bg-rose-500")} />
        {/* 展开的子项前面显示完整时间(北京时间 年月日时分秒);折叠态的紧凑行仍用相对时间。 */}
        {!opts?.compact && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted">{formatTimestamp(r.finishedAt ?? r.startedAt)}</span>
        )}
        {/* 展开态 label 用 flex-1 撑满,把右侧时间挤到整行最右;紧凑态按内容宽即可。 */}
        <span className={cn("min-w-0 truncate text-sm", opts?.compact ? "" : "flex-1", ok ? "text-emerald-600" : "text-rose-600")}>{label}</span>
        <span className={cn("flex shrink-0 items-center gap-1 text-sm text-muted", opts?.compact ? "" : "ml-auto")}>
          {relTime(r.finishedAt ?? r.startedAt)}
          <span className={ok ? "text-emerald-500" : "text-rose-500"}>{ok ? "✓" : "✗"}</span>
        </span>
      </button>
    );
  };
  const rows = runs ?? [group.latest]; // 展开但未拉取到时先用最新 1 条兜底

  return (
    <div>
      {/* 任务项头:折叠按钮 + 名称 +(折叠态)最近一次状态。置顶/删除在此不提供(去掉)。
          h-10 固定头行高度(不是 min-h):折叠态右侧紧凑状态行比纯标题略高,展开后被移除会让
          头行变矮、整条上移一下;固定高度后两种状态强制等高,彻底消除展开/收起时的上下跳动。 */}
      <div className="flex h-10 items-center gap-2 px-2">
        <button type="button" onClick={toggle} aria-label={expanded ? "折叠" : "展开"}
          className="shrink-0 rounded-md p-1 text-muted transition hover:bg-line/50 hover:text-fg">
          <CollapseChevron open={expanded} />
        </button>
        {/* 点击任务名直接展开/收起(不再打开编辑弹窗)。outline-none/select-none:去掉点击后的蓝色聚焦框与文字选中。 */}
        <button type="button" onClick={toggle} className="flex min-w-0 flex-1 select-none items-center gap-2 rounded text-left outline-none">
          {group.pinnedAt && <span aria-hidden title="已置顶" className="shrink-0 text-primary">📌</span>}
          <span className="truncate font-semibold text-fg">{group.name}</span>
        </button>
        {/* 折叠态:右侧直接显示最近一次完成状态(移动端也显示);展开态由下方完整列表呈现,故隐藏以免重复。 */}
        {!expanded && <div className="shrink-0">{runRow(group.latest, { compact: true })}</div>}
      </div>
      {/* 展开态才列出该任务的所有(分页)运行状态;缩进对齐折叠按钮之后。 */}
      {expanded && (
        <div className="flex flex-col pl-7">
          {rows.map((r) => <div key={r.id}>{runRow(r)}</div>)}
          {loading && <div className="px-2 py-2 text-xs text-muted">加载中…</div>}
          {hasMore && !loading && (
            <button type="button" onClick={() => void loadMore()}
              className="mt-1 self-start rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface hover:text-fg">
              加载更多
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// 运行详情:直接复用助手聊天的渲染逻辑(ChatMessageList)。把这次运行拼成一段
// 「提示词(用户)+ 产出(助手)」的合成对话交给聊天列表渲染 —— 气泡/markdown/思考卡/
// 三点脉冲全部与聊天页一致。运行中(仅用户消息 + replying)显示脉冲并轮询到完成。
function runToMessages(detail: AutomationRunDetail): UiChatMessage[] {
  const mk = (id: string, role: "user" | "assistant", content: string, createdAt: string): UiChatMessage =>
    ({ id, role, content, createdAt, citedArticleIds: [], citedRefs: [], mentions: [] });
  const out: UiChatMessage[] = [];
  if (detail.prompt) out.push(mk(`${detail.id}-u`, "user", detail.prompt, detail.startedAt));
  if (detail.status !== "running") out.push(mk(`${detail.id}-a`, "assistant", detail.displayText, detail.finishedAt ?? detail.startedAt));
  return out;
}

function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);

  // 运行详情本身就是聊天式界面(合成的提示词/产出),不该再浮出助手输入框 —— 进入
  // 该页时隐藏浮动聊天气泡,离开(返回列表/切页)时恢复。
  const setAiSuppressed = useAiSurface((s) => s.setSuppressed);
  useEffect(() => {
    setAiSuppressed(true);
    return () => setAiSuppressed(false);
  }, [setAiSuppressed]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(null); setErr(null);
    const load = async () => {
      try {
        const d = await api.automations.getRun(runId);
        if (cancelled) return;
        setDetail(d);
        // 失败时把详情打到浏览器 console,便于排查(错误原因 / 飞书投递结果 / 用时)。
        if (d.status === "failed") {
          console.warn("[automation] 运行失败", {
            runId: d.id, automation: d.automationName, isTest: d.isTest,
            error: d.error, delivery: d.delivery,
            startedAt: d.startedAt, finishedAt: d.finishedAt,
          });
        }
        if (d.status === "running") timer = setTimeout(load, 4000); // 轮询到完成
      } catch (e) { if (!cancelled) setErr((e as Error).message || "加载失败"); }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runId]);

  const messages = useMemo(() => (detail ? runToMessages(detail) : []), [detail]);

  // 二级页面返回:统一图标按钮,放到标题行最左侧。
  const backBtn = <BackButton onClick={onBack} />;
  if (err) return <div><div className="mb-4">{backBtn}</div><p className="text-sm text-rose-600">{err}</p></div>;
  if (!detail) return <div><div className="mb-4">{backBtn}</div><p className="text-sm text-muted">加载中…</p></div>;

  const running = detail.status === "running";
  const ok = detail.status === "success";
  const when = detail.finishedAt ?? detail.startedAt;
  const d = detail.delivery;

  return (
    <div>
      {/* 顶部:返回图标 + 任务名 + 状态(聊天区撑满整页宽度,不再限宽) */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {backBtn}
        <h2 className="text-lg font-semibold text-fg">{detail.automationName}</h2>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium",
          running ? "bg-line/50 text-muted" : ok ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600")}>
          {running ? "运行中" : ok ? "已完成" : "运行失败"}
        </span>
        {detail.isTest && <span className="rounded-full bg-line/50 px-2 py-0.5 text-xs text-muted">测试运行</span>}
      </div>

      {/* 复用聊天列表渲染这段合成对话(需要有界高度让内部滚动生效)。 */}
      <div className="flex h-[62vh] min-h-[400px] flex-col overflow-hidden">
        <ChatMessageList
          messages={messages}
          status={running ? "idle" : ok ? "idle" : "error"}
          error={running || ok ? null : (detail.error ?? "运行失败")}
          replying={running}
          autoScroll={false}
        />
      </div>

      {!running && (
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={rerunning}
            onClick={async () => {
              setRerunning(true);
              try {
                const res = await api.automations.run(detail.automationId);
                toast.success(res.alreadyRunning ? "该任务正在运行中" : "已重新运行,稍后在「执行中/已完成」查看");
              }
              catch { toast.error("触发失败"); }
              finally { setRerunning(false); }
            }}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-fg transition hover:bg-surface disabled:opacity-60">
            ▷ 重新运行
          </button>
          <span className="text-xs text-muted">
            {ok ? "完成" : "结束"}于 {new Date(when).toLocaleString()}
            {d && (d.ok ? ` · 已推送飞书${d.httpStatus ? `(${d.httpStatus})` : ""}` : ` · 投递失败${d.httpStatus ? `(${d.httpStatus})` : ""}`)}
          </span>
        </div>
      )}
    </div>
  );
}

// 编辑态左侧操作:删除 / 测试运行 / 暂停·恢复。
// onRan:测试运行触发成功后,主动关闭编辑弹窗并刷新列表,让「执行中」任务即时出现。
function EditActions({ a, onChanged, onDeleted, onRan, onLocal }: { a: Automation; onChanged: () => void; onDeleted: () => void; onRan: () => void; onLocal: (a: Automation) => void }) {
  const btn = "flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium transition hover:bg-surface";
  return (
    <>
      <button type="button" className={cn(btn, "border-rose-200 text-rose-600 hover:bg-rose-50")}
        onClick={async () => { if (await dialog.confirm(`确定删除「${a.name}」?此操作不可撤销。`, { title: "删除任务", danger: true })) { await api.automations.remove(a.id); toast.success("已删除"); onDeleted(); } }}>
        🗑 删除
      </button>
      <button type="button" className={btn}
        onClick={async () => { try { const res = await api.automations.run(a.id); toast.success(res.alreadyRunning ? "该任务正在运行中" : "测试运行已开始,可在「执行中」查看"); onRan(); } catch { toast.error("触发失败"); } }}>
        ▷ 测试运行
      </button>
      <button type="button" className={btn}
        onClick={async () => { const next = a.enabled ? await api.automations.pause(a.id) : await api.automations.resume(a.id); toast.success(a.enabled ? "已暂停" : "已恢复"); onLocal(next); onChanged(); }}>
        {a.enabled ? "❚❚ 暂停" : "▷ 恢复"}
      </button>
    </>
  );
}
