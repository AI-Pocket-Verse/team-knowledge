import { useState } from "react";
import type { Automation, AutomationInput, AutomationScheduleKind } from "@/lib/api";
import { Select, TimePicker } from "./Select";
import { DatePicker } from "./DatePicker";
import { cn } from "@/lib/cn";

// 北京墙钟(y-m-d h:m)→ 真实 UTC ms(北京=UTC+8)。与后端一致。
function beijingWallToUtcMs(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0) - 8 * 3600_000;
}
const pad = (n: number) => String(n).padStart(2, "0");
// UTC ms → 北京墙钟的 <input type=date> 值 / 时:分。
function utcMsToBeijingDate(ms: number): string {
  const b = new Date(ms + 8 * 3600_000);
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
}
function utcMsToBeijingTime(ms: number): string {
  const b = new Date(ms + 8 * 3600_000);
  return `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`;
}
const WD = [{ v: 1, l: "一" }, { v: 2, l: "二" }, { v: 3, l: "三" }, { v: 4, l: "四" }, { v: 5, l: "五" }, { v: 6, l: "六" }, { v: 7, l: "日" }];
const PRESET_OPTS = [{ value: "daily", label: "每天" }, { value: "weekdays", label: "工作日" }, { value: "weekly", label: "每周" }];
const UNIT_OPTS = [{ value: "min", label: "分钟" }, { value: "hour", label: "小时" }];

// 统一控件样式。
const inputCls = "h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-fg outline-none transition placeholder:text-muted/50 focus:border-primary focus:ring-2 focus:ring-primary/15";

export interface AutomationFormValue extends Partial<AutomationInput> { name?: string; prompt?: string }

interface Props {
  initial?: Automation | AutomationFormValue; // 编辑传 Automation;从模板/新建传预填值
  onSubmit: (input: AutomationInput) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  leftActions?: React.ReactNode; // 编辑态:删除 / 测试运行 / 暂停·恢复
}

export function AutomationForm({ initial, onSubmit, onCancel, submitting, leftActions }: Props) {
  const init = (initial ?? {}) as Automation & AutomationFormValue;
  const [name, setName] = useState(init.name ?? "");
  const [prompt, setPrompt] = useState(init.prompt ?? "");
  const [webhookUrl, setWebhookUrl] = useState(init.webhookUrl ?? "");
  const [kind, setKind] = useState<AutomationScheduleKind>(init.scheduleKind ?? "cron");

  const cfg = init.scheduleConfig ?? {};
  // 周期
  const initPreset = kind === "cron"
    ? (cfg.weekdays?.length === 7 ? "daily" : cfg.weekdays?.length === 5 && [1, 2, 3, 4, 5].every((d) => cfg.weekdays!.includes(d)) ? "weekdays" : "weekly")
    : "daily";
  const [preset, setPreset] = useState<"daily" | "weekdays" | "weekly">(initPreset);
  const [weekdays, setWeekdays] = useState<number[]>(cfg.weekdays ?? [1]);
  const [time, setTime] = useState(kind === "cron" && cfg.hour != null ? `${pad(cfg.hour)}:${pad(cfg.minute ?? 0)}` : "09:00");
  // 按间隔
  const [intervalN, setIntervalN] = useState(kind === "interval" && cfg.everyMs ? (cfg.everyMs % 3600_000 === 0 ? cfg.everyMs / 3600_000 : Math.round(cfg.everyMs / 60_000)) : 30);
  const [intervalUnit, setIntervalUnit] = useState<"min" | "hour">(kind === "interval" && cfg.everyMs && cfg.everyMs % 3600_000 === 0 ? "hour" : "min");
  // 单次:拆成日期 + 时:分
  const [onceDate, setOnceDate] = useState(kind === "once" && cfg.atMs ? utcMsToBeijingDate(cfg.atMs) : "");
  const [onceTime, setOnceTime] = useState(kind === "once" && cfg.atMs ? utcMsToBeijingTime(cfg.atMs) : "09:00");
  // 生效区间
  const [effFrom, setEffFrom] = useState(init.effectiveFrom ? utcMsToBeijingDate(new Date(init.effectiveFrom).getTime()) : "");
  const [effTo, setEffTo] = useState(init.effectiveTo ? utcMsToBeijingDate(new Date(init.effectiveTo).getTime()) : "");
  const [showRange, setShowRange] = useState<boolean>(!!(init.effectiveFrom || init.effectiveTo)); // 默认收起,清爽
  const [err, setErr] = useState<string | null>(null);

  function toggleWeekday(v: number) {
    setWeekdays((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v].sort((a, b) => a - b)));
  }

  function build(): AutomationInput | null {
    if (!name.trim()) { setErr("请填写名称"); return null; }
    if (!prompt.trim()) { setErr("请填写提示词"); return null; }
    let scheduleConfig: AutomationInput["scheduleConfig"];
    if (kind === "cron") {
      const [h, mi] = time.split(":").map(Number);
      const wds = preset === "daily" ? [1, 2, 3, 4, 5, 6, 7] : preset === "weekdays" ? [1, 2, 3, 4, 5] : weekdays;
      if (wds.length === 0) { setErr("请至少选择一个星期几"); return null; }
      scheduleConfig = { weekdays: wds, hour: h, minute: mi };
    } else if (kind === "interval") {
      const everyMs = intervalN * (intervalUnit === "hour" ? 3600_000 : 60_000);
      if (everyMs < 600_000) { setErr("间隔至少 10 分钟"); return null; }
      scheduleConfig = { everyMs };
    } else {
      if (!onceDate) { setErr("请选择单次执行日期"); return null; }
      const [y, mo, dd] = onceDate.split("-").map(Number);
      const [h, mi] = (onceTime || "09:00").split(":").map(Number);
      scheduleConfig = { atMs: beijingWallToUtcMs(y, mo, dd, h, mi) };
    }
    const effectiveFrom = effFrom ? beijingWallToUtcMs(...(effFrom.split("-").map(Number) as [number, number, number]), 0, 0) : null;
    const effectiveTo = effTo ? beijingWallToUtcMs(...(effTo.split("-").map(Number) as [number, number, number]), 23, 59) : null;
    return { name: name.trim(), prompt: prompt.trim(), webhookUrl: webhookUrl.trim() || null, scheduleKind: kind, scheduleConfig, effectiveFrom, effectiveTo };
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 可滚动主体 */}
      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="给任务起个名字" className={inputCls} />
        </Field>

        <Field label="提示词">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} maxLength={8000}
            placeholder="描述要做什么、产出格式(如整理成飞书 interactive 卡片 JSON)…"
            className="w-full resize-y rounded-lg border border-line bg-white px-3 py-2.5 text-sm leading-relaxed text-fg outline-none transition placeholder:text-muted/50 focus:border-primary focus:ring-2 focus:ring-primary/15" />
        </Field>

        <Field label="webhook 地址" hint="(可选,留空则只运行不推送)">
          <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} maxLength={500}
            placeholder="飞书机器人 webhook,如 https://open.feishu.cn/open-apis/bot/v2/hook/…" className={inputCls} />
        </Field>

        <Field label="执行频率" hint="(北京时间)">
          <div className="mb-3 inline-flex rounded-lg bg-line/40 p-1 text-xs">
            {([["cron", "周期"], ["interval", "按间隔"], ["once", "单次"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={cn("rounded-md px-4 py-1.5 font-medium transition", kind === k ? "bg-white text-fg shadow-sm" : "text-muted hover:text-fg")}>{l}</button>
            ))}
          </div>
          {kind === "cron" && (
            <div className="flex flex-wrap items-center gap-2">
              <Select className="w-[104px]" value={preset} options={PRESET_OPTS} onChange={(v) => setPreset(v as typeof preset)} />
              {preset === "weekly" && (
                <div className="flex gap-1">
                  {WD.map((d) => (
                    <button key={d.v} type="button" onClick={() => toggleWeekday(d.v)}
                      className={cn("h-9 w-9 rounded-md border text-sm transition", weekdays.includes(d.v) ? "border-primary bg-accent-soft font-medium text-primary" : "border-line text-muted hover:bg-surface")}>{d.l}</button>
                  ))}
                </div>
              )}
              <TimePicker value={time} onChange={setTime} />
            </div>
          )}
          {kind === "interval" && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">每</span>
              <input type="number" min={1} value={intervalN} onChange={(e) => setIntervalN(Math.max(1, Number(e.target.value) || 1))}
                className={cn(inputCls, "w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none")} />
              <Select className="w-[88px]" value={intervalUnit} options={UNIT_OPTS} onChange={(v) => setIntervalUnit(v as "min" | "hour")} />
            </div>
          )}
          {kind === "once" && (
            <div className="flex flex-wrap items-center gap-2">
              <DatePicker value={onceDate} onChange={setOnceDate} className="w-[168px]" />
              <TimePicker value={onceTime} onChange={setOnceTime} />
            </div>
          )}
        </Field>

        <Field label="生效日期区间" hint="(可选,留空表示始终生效)">
          {!showRange ? (
            <button type="button" onClick={() => setShowRange(true)}
              className="flex h-10 w-full items-center rounded-lg border border-dashed border-line bg-white px-3 text-left text-sm text-muted transition hover:border-primary/50 hover:text-fg">
              ＋ 选择生效日期
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <DatePicker value={effFrom} onChange={setEffFrom} placeholder="开始日期" className="w-[150px]" />
              <span className="text-muted">至</span>
              <DatePicker value={effTo} onChange={setEffTo} placeholder="结束日期" className="w-[150px]" />
              <button type="button" onClick={() => { setEffFrom(""); setEffTo(""); setShowRange(false); }}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface hover:text-fg">清除</button>
            </div>
          )}
        </Field>
      </div>

      {/* 常驻底部操作条 */}
      <div className="shrink-0 border-t border-line px-6 py-3">
        {err && <p className="mb-2 text-sm text-rose-600">{err}</p>}
        <div className="flex items-center gap-2">
          {leftActions}
          <div className="ml-auto" />
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-5 py-2 text-sm font-medium text-fg transition hover:bg-surface">取消</button>
          <button type="button" disabled={submitting}
            onClick={() => { setErr(null); const v = build(); if (v) void onSubmit(v); }}
            className="rounded-lg bg-fg px-5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60">保存</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-fg">{label}{hint && <span className="ml-1 font-normal text-muted">{hint}</span>}</label>
      {children}
    </div>
  );
}
