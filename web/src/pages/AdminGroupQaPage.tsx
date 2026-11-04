import { useEffect, useState } from "react";
import { api, type GroupQaStatEntry, type GroupQaTuning, type GroupQaLike, type GroupQaLikeEntry, GROUP_QA_LIKE_EMOJIS } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { toast } from "@/components/Toaster";
import { getAssistantName } from "@/lib/assistantName";
import { useT, type MessageKey } from "@/i18n";

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
  const t = useT();
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
          { key: "answers" as const, label: `${t("admin.gq.tabAnswers")}${entries ? `(${entries.length})` : ""}` },
          { key: "likes" as const, label: `${t("admin.gq.tabLikes")}${likes ? `(${likes.length})` : ""}` },
          ...(isAdmin ? [
            { key: "tuning" as const, label: t("admin.gq.tabTuning") },
            { key: "likeConfig" as const, label: t("admin.gq.tabLikeConfig") },
          ] : []),
        ]).map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setTab(tb.key)}
            className={
              "-mb-px px-3 py-2 text-sm transition " +
              (tab === tb.key ? "border-b-2 border-primary font-medium text-primary" : "text-muted hover:text-fg")
            }
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* 答疑记录 */}
      {tab === "answers" && (
        <div className="flex flex-col gap-4">
          {/* 互动规则说明:所有能看到本页的人都能读,理解机器人为何「克制」。 */}
          <div className="rounded-xl border border-line bg-white p-4 text-xs leading-relaxed text-muted shadow-glass">
            <p>
              {t("admin.gq.rule1", { name: getAssistantName() })}<strong className="text-fg">{t("admin.gq.rule1b")}</strong>{t("admin.gq.rule2")}<strong className="text-fg">{t("admin.gq.rule2b")}</strong>{t("admin.gq.rule3")}<strong className="text-fg">{t("admin.gq.rule3b")}</strong>{t("admin.gq.rule4")}<strong className="text-fg">{t("admin.gq.rule4b")}</strong>{t("admin.gq.rule5")}<strong className="text-fg">{t("admin.gq.rule5b")}</strong>{t("admin.gq.rule6")}
            </p>
          </div>
          <p className="text-xs text-muted">{t("admin.gq.answersDesc")}</p>
          {entries.length === 0 ? (
            <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
              {t("admin.gq.answersEmpty")}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colTime")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colGroup")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colQuestion")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.backup.colSource")}</th>
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
                      <td className="px-4 py-2 text-muted">{e.sourceTitle ? t("admin.gq.sourceTitle", { title: e.sourceTitle }) : "—"}</td>
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
          <p className="text-xs text-muted">{t("admin.gq.likesDesc")}</p>
          {likes === null ? (
            <div className="rounded-xl border border-line bg-white px-8 py-8 text-center text-sm text-muted">{t("admin.gq.likesLoading")}</div>
          ) : likes.length === 0 ? (
            <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
              {t("admin.gq.likesEmpty")}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colTime")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colGroup")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colSender")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colScore")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colEmoji")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.gq.colPreview")}</th>
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
const FIELDS: { key: keyof GroupQaTuning; label: MessageKey; unit: MessageKey; min: number; max: number; def: number; hint: MessageKey }[] = [
  { key: "cooldownSec", label: "admin.gq.f.cooldownSec", unit: "admin.gq.unit.sec", min: 5, max: 3600, def: 45, hint: "admin.gq.f.cooldownSec.hint" },
  { key: "hourlyCap", label: "admin.gq.f.hourlyCap", unit: "admin.gq.unit.count", min: 1, max: 100, def: 6, hint: "admin.gq.f.hourlyCap.hint" },
  { key: "dedupMin", label: "admin.gq.f.dedupMin", unit: "admin.gq.unit.min", min: 1, max: 1440, def: 30, hint: "admin.gq.f.dedupMin.hint" },
  { key: "demoteDays", label: "admin.gq.f.demoteDays", unit: "admin.gq.unit.day", min: 1, max: 90, def: 7, hint: "admin.gq.f.demoteDays.hint" },
  { key: "answerCap", label: "admin.gq.f.answerCap", unit: "admin.gq.unit.char", min: 40, max: 1000, def: 160, hint: "admin.gq.f.answerCap.hint" },
];

// 答疑积极度:1-3 的语义档,是「克制 ↔ 频繁」的主闸门(调 LLM 判定松紧 + 检索候选数)。
// 三档各对应不同后端行为(prompt + 检索数),每档切换都有实感。用分段按钮而非原生 select
// (守 CLAUDE.md 规则 2:禁原生弹层型控件)。
const AGG_LEVELS: { v: number; label: MessageKey }[] = [
  { v: 1, label: "admin.gq.agg1" },
  { v: 2, label: "admin.gq.agg2" },
  { v: 3, label: "admin.gq.agg3" },
];
const AGG_DESC: Record<number, MessageKey> = {
  1: "admin.gq.agg1d",
  2: "admin.gq.agg2d",
  3: "admin.gq.agg3d",
};

function TuningPanel() {
  const t = useT();
  const [tuning, setTuning] = useState<GroupQaTuning | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.groupQa.tuning.get().then(setTuning).catch((e) => toast.error((e as Error).message || t("error.loadFailed")));
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
      toast.success(t("admin.gq.tuningSaved"));
    } catch (e) {
      toast.error((e as Error).message || t("error.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!tuning) return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("admin.gq.tuningLoading")}</div>;

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
          <div className="text-sm font-medium text-fg">{t("admin.gq.tuningTitle")}</div>
          <div className="mt-0.5 text-xs text-muted">{t("admin.gq.tuningDesc")}</div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || invalid}
          title={invalid ? t("admin.gq.invalid") : undefined}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      {/* 答疑积极度:主闸门,决定「要不要答一个能答的问题」的松紧 */}
      <div className="mt-3 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg">{t("admin.gq.aggTitle")}</span>
          <span className="text-[11px] text-muted">{t("admin.gq.aggHint")}</span>
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
                {l.v} · {t(l.label)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted">{AGG_DESC[tuning.aggressiveness] ? t(AGG_DESC[tuning.aggressiveness]) : ""}</p>
      </div>

      <div className="mt-3 text-xs font-medium text-fg">{t("admin.gq.valves")}</div>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => {
          const err = bad(f);
          return (
            <label key={f.key} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
              <span className="text-xs font-medium text-fg">{t(f.label)}</span>
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
                <span className="text-xs text-muted">{t(f.unit)}</span>
              </span>
              <span className={`text-[11px] leading-snug ${err ? "text-rose-600" : "text-muted"}`}>
                {err ? t("admin.gq.range", { min: f.min, max: f.max }) : t(f.hint)}
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
const LIKE_FIELDS: { key: LikeNumField; label: MessageKey; unit: MessageKey; min: number; max: number; hint: MessageKey }[] = [
  { key: "threshold", label: "admin.gq.l.threshold", unit: "admin.gq.unit.score", min: 1, max: 10, hint: "admin.gq.l.threshold.hint" },
  { key: "dailyCapPerGroup", label: "admin.gq.l.dailyCapPerGroup", unit: "admin.gq.unit.count", min: 1, max: 50, hint: "admin.gq.l.dailyCapPerGroup.hint" },
  { key: "cooldownMin", label: "admin.gq.l.cooldownMin", unit: "admin.gq.unit.min", min: 1, max: 1440, hint: "admin.gq.l.cooldownMin.hint" },
  { key: "userDailyCap", label: "admin.gq.l.userDailyCap", unit: "admin.gq.unit.count", min: 1, max: 20, hint: "admin.gq.l.userDailyCap.hint" },
  { key: "evalDailyBudget", label: "admin.gq.l.evalDailyBudget", unit: "admin.gq.unit.count", min: 10, max: 5000, hint: "admin.gq.l.evalDailyBudget.hint" },
];
const LIKE_EMOJI_LABEL: Record<string, MessageKey> = {
  THUMBSUP: "admin.gq.e.THUMBSUP", OK: "admin.gq.e.OK", DONE: "admin.gq.e.DONE", HEART: "admin.gq.e.HEART", APPLAUSE: "admin.gq.e.APPLAUSE", FINGERHEART: "admin.gq.e.FINGERHEART",
};
// 看板里只显示表情符号(键为飞书 emoji_type)。未知值回退 👍。
const LIKE_EMOJI_CHAR: Record<string, string> = {
  THUMBSUP: "👍", OK: "🆗", DONE: "✅", HEART: "❤️", APPLAUSE: "👏", FINGERHEART: "🫰",
};

function LikePanel() {
  const t = useT();
  const [cfg, setCfg] = useState<GroupQaLike | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.groupQa.like.get().then(setCfg).catch((e) => toast.error((e as Error).message || t("error.loadFailed")));
  }, []);

  function setNum(key: LikeNumField, raw: string) {
    setCfg((c) => (c ? { ...c, [key]: raw === "" ? (NaN as unknown as number) : Number(raw) } : c));
  }

  if (!cfg) return <div className="rounded-xl border border-line bg-white p-4 text-sm text-muted shadow-glass">{t("admin.gq.likeLoading")}</div>;

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
      toast.success(t("admin.gq.likeSaved"));
    } catch (e) {
      toast.error((e as Error).message || t("error.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">{t("admin.gq.likeTitle")}</div>
          <div className="mt-0.5 text-xs text-muted">{t("admin.gq.likeDesc")}</div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || invalid}
          title={invalid ? t("admin.gq.invalid") : undefined}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      {/* 总开关 + 点赞表情:分段按钮,不用原生控件(守 CLAUDE.md 规则 2) */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg">{t("admin.gq.switch")}</span>
          <div className="flex gap-1.5">
            {[{ v: true, label: t("admin.gq.on") }, { v: false, label: t("admin.gq.off") }].map((o) => {
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
          <span className="text-xs font-medium text-fg">{t("admin.gq.emojiMode")}</span>
          <div className="flex gap-1.5">
            {[{ v: "smart", label: t("admin.gq.smart") }, { v: "fixed", label: t("admin.gq.fixed") }].map((o) => {
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
          <span className="text-xs font-medium text-fg">{cfg.emojiMode === "smart" ? t("admin.gq.fallbackEmoji") : t("admin.gq.likeEmoji")}</span>
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
                  {LIKE_EMOJI_LABEL[em] ? t(LIKE_EMOJI_LABEL[em]) : em}
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
              <span className="text-xs font-medium text-fg">{t(f.label)}</span>
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
                <span className="text-xs text-muted">{t(f.unit)}</span>
              </span>
              <span className={`text-[11px] leading-snug ${err ? "text-rose-600" : "text-muted"}`}>
                {err ? t("admin.gq.range", { min: f.min, max: f.max }) : t(f.hint)}
              </span>
            </label>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-snug text-muted">
        {t("admin.gq.note1")}<strong className="text-fg">{t("admin.gq.smart")}</strong>{t("admin.gq.note2")}<strong className="text-fg">{t("admin.gq.fixed")}</strong>{t("admin.gq.note3")}
      </p>
    </div>
  );
}
