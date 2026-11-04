import { useEffect, useState } from "react";
import { api, type GroupQaStatEntry, type GroupQaTuning, type GroupQaLike, type GroupQaLikeEntry, GROUP_QA_LIKE_EMOJIS } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { toast } from "@/components/Toaster";
import { getAssistantName } from "@/lib/assistantName";

// 群答疑记录看板。看板本身对「已放开」的成员只读;顶部「互动节奏」参数是全局行为设置,
// 仅管理员可见可改(同 doc-audit 检测配置)。开关与目标群仍在「飞书群任务 → 群聊智能答疑」。
function fmtBeijing(ms: number): string {
  const d = new Date(ms + 8 * 3600000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 访问门控由路由层 RequireAdminPage(pageKey="group-qa")负责:管理员,或该页已在
// 「页面可见性」放开给所有成员。不再自拦 isAdmin(否则放开后成员会被弹走)。
export function AdminGroupQaPage() {
  return <Inner />;
}

function Inner() {
  const isAdmin = useIsAdmin();
  const [entries, setEntries] = useState<GroupQaStatEntry[] | null>(null);
  const [likes, setLikes] = useState<GroupQaLikeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 分标签页展示:答疑记录 / 点赞记录 /(管理员)互动节奏 / 群消息点赞。默认停在答疑记录,
  // 故非管理员进来不会落到隐藏的配置 tab(同文档校验页)。
  const [tab, setTab] = useState<"answers" | "likes" | "tuning" | "likeConfig">("answers");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.admin.groupQa.stats();
        if (!cancelled) setEntries(r.entries);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    // 点赞看板独立拉取:失败不影响答疑看板(留空即可,不弹错)。
    void (async () => {
      try {
        const r = await api.admin.groupQa.likes();
        if (!cancelled) setLikes(r.entries);
      } catch {
        if (!cancelled) setLikes([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="text-sm text-rose-600">⚠ {error}</div>;
  if (!entries) return <DelayedLoader />;

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Tab 栏(同文档校验页):记录页对所有人可见;配置页仅管理员。 */}
      <div className="flex gap-1 border-b border-line">
        {([
          { key: "answers" as const, label: `答疑记录${entries ? `(${entries.length})` : ""}` },
          { key: "likes" as const, label: `点赞记录${likes ? `(${likes.length})` : ""}` },
          ...(isAdmin ? [
            { key: "tuning" as const, label: "互动节奏" },
            { key: "likeConfig" as const, label: "群消息点赞" },
          ] : []),
        ]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              "-mb-px px-3 py-2 text-sm transition " +
              (tab === t.key ? "border-b-2 border-primary font-medium text-primary" : "text-muted hover:text-fg")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 答疑记录 */}
      {tab === "answers" && (
        <div className="flex flex-col gap-4">
          {/* 互动规则说明:所有能看到本页的人都能读,理解机器人为何「克制」。 */}
          <div className="rounded-xl border border-line bg-white p-4 text-xs leading-relaxed text-muted shadow-glass">
            <p>
              机器人 {getAssistantName()} 在群里<strong className="text-fg">偏克制、只答不聊</strong>:一条非 @ 的群消息要连过几道关才会回复 ——
              ① 该群在「飞书群任务 → 群聊智能答疑」里被<strong className="text-fg">显式勾选</strong>;
              ② 消息<strong className="text-fg">像个问题</strong>(带问号或求助/求证/索取语气);
              ③ 在<strong className="text-fg">已发布知识库</strong>里检索到相关文档,且 AI 判定「文档确实在讲这个问题」才回,闲聊/个人动态/文档没覆盖一律不答;
              ④ 通过<strong className="text-fg">限频与去重</strong>(见「互动节奏」)。以「引用原消息」形式回复,附来源与 👍/👎。被 👎 的问题会短期静默。
            </p>
          </div>
          <p className="text-xs text-muted">机器人在群里主动答疑的命中记录(最近 100 条)。开关与目标群在「飞书群任务 → 💬 群聊智能答疑」配置。</p>
          {entries.length === 0 ? (
            <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
              还没有答疑记录。开启「群聊智能答疑」并在群里提出知识库能回答的问题后,这里会出现命中记录。
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">群</th>
                    <th className="px-4 py-2 font-medium">问题</th>
                    <th className="px-4 py-2 font-medium">来源</th>
                    <th className="px-4 py-2 font-medium">👍</th>
                    <th className="px-4 py-2 font-medium">👎</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={`${e.hash}-${e.at}-${i}`} className="border-t border-line align-middle transition hover:bg-surface">
                      <td className="whitespace-nowrap px-4 py-2 text-muted">{fmtBeijing(e.at)}</td>
                      <td className="px-4 py-2">{e.chatName}</td>
                      <td className="px-4 py-2">{e.question}</td>
                      <td className="px-4 py-2 text-muted">{e.sourceTitle ? `《${e.sourceTitle}》` : "—"}</td>
                      <td className="px-4 py-2 tabular-nums text-emerald-700">{e.upvotes > 0 ? e.upvotes : ""}</td>
                      <td className="px-4 py-2 tabular-nums text-rose-700">{e.downvotes > 0 ? e.downvotes : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 点赞记录 */}
      {tab === "likes" && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">机器人对它判定为「好」的群消息自动点赞的明细(最近 100 条)。开关与阈值在「群消息点赞」里配置。</p>
          {likes === null ? (
            <div className="rounded-xl border border-line bg-white px-8 py-8 text-center text-sm text-muted">加载点赞记录…</div>
          ) : likes.length === 0 ? (
            <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
              还没有点赞记录。在「群消息点赞」里开启功能后,机器人点赞的消息会出现在这里。
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">群</th>
                    <th className="px-4 py-2 font-medium">发送人</th>
                    <th className="px-4 py-2 font-medium">分数</th>
                    <th className="px-4 py-2 font-medium">表情</th>
                    <th className="px-4 py-2 font-medium">消息摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {likes.map((e, i) => (
                    <tr key={`${e.messageId}-${i}`} className="border-t border-line align-middle transition hover:bg-surface">
                      <td className="whitespace-nowrap px-4 py-2 text-muted">{fmtBeijing(e.at)}</td>
                      <td className="px-4 py-2">{e.chatName}</td>
                      <td className="px-4 py-2">{e.senderName}</td>
                      <td className="px-4 py-2 tabular-nums text-emerald-700">{e.score}</td>
                      <td className="px-4 py-2 text-base" title={e.emoji}>{LIKE_EMOJI_CHAR[e.emoji] ?? "👍"}</td>
                      <td className="px-4 py-2 text-muted">{e.preview}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "tuning" && isAdmin && <TuningPanel />}
      {tab === "likeConfig" && isAdmin && <LikePanel />}
    </div>
  );
}

// 互动节奏参数(仅管理员)。字段与 api.GroupQaTuning 对齐;def 为后端默认值(仅作展示参考,
// 空/越界不会静默回退——由 invalid 校验拦在保存前,见 save/bad)。
const FIELDS: { key: keyof GroupQaTuning; label: string; unit: string; min: number; max: number; def: number; hint: string }[] = [
  { key: "cooldownSec", label: "同群冷却间隔", unit: "秒", min: 5, max: 3600, def: 45, hint: "同一个群两次主动回答的最短间隔,越大越克制" },
  { key: "hourlyCap", label: "每群每小时上限", unit: "条", min: 1, max: 100, def: 6, hint: "同一个群每小时最多主动回答几条,防刷屏" },
  { key: "dedupMin", label: "同问题去重", unit: "分钟", min: 1, max: 1440, def: 30, hint: "同一个问题多少分钟内不重复回答" },
  { key: "demoteDays", label: "👎 降权保留", unit: "天", min: 1, max: 90, def: 7, hint: "被「👎 没帮助」的问题,多少天内不再回答" },
  { key: "answerCap", label: "答案字数上限", unit: "字", min: 40, max: 1000, def: 160, hint: "单条回答的最大字数(超出截断)" },
];

// 答疑积极度:1-3 的语义档,是「克制 ↔ 频繁」的主闸门(调 LLM 判定松紧 + 检索候选数)。
// 三档各对应不同后端行为(prompt + 检索数),每档切换都有实感。用分段按钮而非原生 select
// (守 CLAUDE.md 规则 2:禁原生弹层型控件)。
const AGG_LEVELS: { v: number; label: string }[] = [
  { v: 1, label: "保守" },
  { v: 2, label: "适中" },
  { v: 3, label: "积极" },
];
const AGG_DESC: Record<number, string> = {
  1: "只回答与文档高度对题的问题,拿不准就不答 —— 最克制。",
  2: "文档相关、能帮上忙就回答 —— 折中。",
  3: "只要文档沾边、能提供线索就搭话(把握不大时会标注「可能相关」)—— 最频繁。始终只依据文档,不编造。",
};

function TuningPanel() {
  const [tuning, setTuning] = useState<GroupQaTuning | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.groupQa.tuning.get().then(setTuning).catch((e) => toast.error((e as Error).message || "加载失败"));
  }, []);

  function setField(key: keyof GroupQaTuning, raw: string) {
    setTuning((t) => (t ? { ...t, [key]: raw === "" ? (NaN as unknown as number) : Number(raw) } : t));
  }
  function setAgg(v: number) {
    setTuning((t) => (t ? { ...t, aggressiveness: v } : t));
  }

  async function save() {
    if (!tuning || invalid) return; // 有非法字段时按钮已禁用,双保险
    // 走到这里所有字段都已在 [min,max] 内,取整即可(不做静默夹紧,避免把用户看不见的
    // 修正落库;越界/空由下方 invalid 拦在保存前)。后端仍会夹一次兜底。
    const body: GroupQaTuning = { ...tuning };
    for (const f of FIELDS) body[f.key] = Math.floor(tuning[f.key]);
    setSaving(true);
    try {
      const next = await api.admin.groupQa.tuning.set(body);
      setTuning(next);
      toast.success("已保存互动节奏参数");
    } catch (e) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!tuning) return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">加载互动节奏参数…</div>;

  // 校验前置:任一字段为空/NaN/越界都算非法 → 禁用保存 + 标红提示,绝不静默改动用户输入。
  const bad = (f: (typeof FIELDS)[number]) => {
    const v = tuning[f.key];
    return !Number.isFinite(v) || v < f.min || v > f.max;
  };
  const invalid = FIELDS.some(bad);

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">互动节奏(仅管理员)</div>
          <div className="mt-0.5 text-xs text-muted">调节机器人在群里主动答疑的频繁 / 克制程度,对所有已勾选的群生效。</div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || invalid}
          title={invalid ? "有字段为空或超出允许范围,请先修正" : undefined}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      {/* 答疑积极度:主闸门,决定「要不要答一个能答的问题」的松紧 */}
      <div className="mt-3 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg">答疑积极度</span>
          <span className="text-[11px] text-muted">「克制 ↔ 频繁」的主开关(比下面的限流阀更能决定回复多少)</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {AGG_LEVELS.map((l) => {
            const on = tuning.aggressiveness === l.v;
            return (
              <button
                key={l.v}
                type="button"
                disabled={saving}
                onClick={() => setAgg(l.v)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${on ? "bg-primary text-white" : "border border-line bg-white text-fg hover:bg-surface"}`}
              >
                {l.v} · {l.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted">{AGG_DESC[tuning.aggressiveness] ?? ""}</p>
      </div>

      <div className="mt-3 text-xs font-medium text-fg">限流阀(封顶回复频率,通常不是主要瓶颈)</div>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => {
          const err = bad(f);
          return (
            <label key={f.key} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
              <span className="text-xs font-medium text-fg">{f.label}</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={Number.isFinite(tuning[f.key]) ? tuning[f.key] : ""}
                  disabled={saving}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className={`w-24 rounded-lg border bg-white px-2 py-1 text-sm tabular-nums ${err ? "border-rose-400" : "border-line"}`}
                />
                <span className="text-xs text-muted">{f.unit}</span>
              </span>
              <span className={`text-[11px] leading-snug ${err ? "text-rose-600" : "text-muted"}`}>
                {err ? `请填 ${f.min}–${f.max} 之间的整数` : f.hint}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// 群消息「AI 点赞」设置(仅管理员)。机器人对判定为「好」的群消息自动加飞书表情回复。
type LikeNumField = "threshold" | "dailyCapPerGroup" | "cooldownMin" | "userDailyCap" | "evalDailyBudget";
const LIKE_FIELDS: { key: LikeNumField; label: string; unit: string; min: number; max: number; hint: string }[] = [
  { key: "threshold", label: "质量分阈值", unit: "分", min: 1, max: 10, hint: "AI 打 0–10 分,达到该分才点赞。越高越挑剔(建议 8)" },
  { key: "dailyCapPerGroup", label: "每群每日上限", unit: "条", min: 1, max: 50, hint: "同一个群每天最多点几个赞,防滥赞" },
  { key: "cooldownMin", label: "同群点赞冷却", unit: "分钟", min: 1, max: 1440, hint: "同一个群两次点赞的最短间隔" },
  { key: "userDailyCap", label: "每人每日被赞上限", unit: "条", min: 1, max: 20, hint: "同一个人每天最多被点几个赞,防偏袒刷屏" },
  { key: "evalDailyBudget", label: "每日评估预算", unit: "条", min: 10, max: 5000, hint: "每天最多用 AI 评估多少条消息(控成本);预筛不计入" },
];
const LIKE_EMOJI_LABEL: Record<string, string> = {
  THUMBSUP: "👍 赞", OK: "🆗 OK", DONE: "✅ 完成", HEART: "❤️ 爱心", APPLAUSE: "👏 鼓掌", FINGERHEART: "🫰 比心",
};
// 看板里只显示表情符号(键为飞书 emoji_type)。未知值回退 👍。
const LIKE_EMOJI_CHAR: Record<string, string> = {
  THUMBSUP: "👍", OK: "🆗", DONE: "✅", HEART: "❤️", APPLAUSE: "👏", FINGERHEART: "🫰",
};

function LikePanel() {
  const [cfg, setCfg] = useState<GroupQaLike | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.groupQa.like.get().then(setCfg).catch((e) => toast.error((e as Error).message || "加载失败"));
  }, []);

  function setNum(key: LikeNumField, raw: string) {
    setCfg((c) => (c ? { ...c, [key]: raw === "" ? (NaN as unknown as number) : Number(raw) } : c));
  }

  if (!cfg) return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">加载点赞设置…</div>;

  const bad = (f: (typeof LIKE_FIELDS)[number]) => {
    const v = cfg[f.key];
    return !Number.isFinite(v) || v < f.min || v > f.max;
  };
  const invalid = LIKE_FIELDS.some(bad);

  async function save() {
    if (!cfg || invalid) return;
    const body: GroupQaLike = { ...cfg };
    for (const f of LIKE_FIELDS) body[f.key] = Math.floor(cfg[f.key]);
    setSaving(true);
    try {
      const next = await api.admin.groupQa.like.set(body);
      setCfg(next);
      toast.success("已保存点赞设置");
    } catch (e) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">群消息点赞(仅管理员)</div>
          <div className="mt-0.5 text-xs text-muted">机器人对它判定为「好」的群消息自动点赞(先规则预筛,再 AI 打分)。点赞是稀缺正反馈,建议从严。</div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || invalid}
          title={invalid ? "有字段为空或超出允许范围,请先修正" : undefined}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      {/* 总开关 + 点赞表情:分段按钮,不用原生控件(守 CLAUDE.md 规则 2) */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg">功能开关</span>
          <div className="flex gap-1.5">
            {[{ v: true, label: "开启" }, { v: false, label: "关闭" }].map((o) => {
              const on = cfg.enabled === o.v;
              return (
                <button
                  key={String(o.v)}
                  type="button"
                  disabled={saving}
                  onClick={() => setCfg((c) => (c ? { ...c, enabled: o.v } : c))}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${on ? "bg-primary text-white" : "border border-line bg-white text-fg hover:bg-surface"}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg">表情模式</span>
          <div className="flex gap-1.5">
            {[{ v: "smart", label: "智能选择" }, { v: "fixed", label: "固定" }].map((o) => {
              const on = cfg.emojiMode === o.v;
              return (
                <button
                  key={o.v}
                  type="button"
                  disabled={saving}
                  onClick={() => setCfg((c) => (c ? { ...c, emojiMode: o.v } : c))}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${on ? "bg-primary text-white" : "border border-line bg-white text-fg hover:bg-surface"}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg">{cfg.emojiMode === "smart" ? "兜底表情" : "点赞表情"}</span>
          <div className="flex flex-wrap gap-1.5">
            {GROUP_QA_LIKE_EMOJIS.map((em) => {
              const on = cfg.emoji === em;
              return (
                <button
                  key={em}
                  type="button"
                  disabled={saving}
                  onClick={() => setCfg((c) => (c ? { ...c, emoji: em } : c))}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${on ? "bg-primary text-white" : "border border-line bg-white text-fg hover:bg-surface"}`}
                >
                  {LIKE_EMOJI_LABEL[em] ?? em}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {LIKE_FIELDS.map((f) => {
          const err = bad(f);
          return (
            <label key={f.key} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
              <span className="text-xs font-medium text-fg">{f.label}</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={Number.isFinite(cfg[f.key]) ? cfg[f.key] : ""}
                  disabled={saving}
                  onChange={(e) => setNum(f.key, e.target.value)}
                  className={`w-24 rounded-lg border bg-white px-2 py-1 text-sm tabular-nums ${err ? "border-rose-400" : "border-line"}`}
                />
                <span className="text-xs text-muted">{f.unit}</span>
              </span>
              <span className={`text-[11px] leading-snug ${err ? "text-rose-600" : "text-muted"}`}>
                {err ? `请填 ${f.min}–${f.max} 之间的整数` : f.hint}
              </span>
            </label>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-snug text-muted">
        表情模式:<strong className="text-fg">智能选择</strong> = AI 按消息情形从正向表情里选(👍解决问题用 ✅、暖心用 ❤️、出色用 👏…),拿不准回退「兜底表情」;<strong className="text-fg">固定</strong> = 一律用所选表情。
        点赞复用「群聊智能答疑」的启用与目标群设置(未勾选的群不点)。飞书侧需给机器人开「发送、删除消息表情回复」(应用身份)权限并发布新版本才生效。
      </p>
    </div>
  );
}
