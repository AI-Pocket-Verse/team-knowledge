// 自动化任务的调度计算。时区固定【北京时间 Asia/Shanghai = UTC+8,无夏令时】,
// 用固定 +8 偏移把「北京墙钟」和真实 UTC 时刻互转,避开 JS Date 无内建时区的坑。
//
// scheduleKind / scheduleConfig:
//   cron     : { weekdays: number[] (1=周一..7=周日), hour, minute }  —— 每天=[1..7]、工作日=[1..5]
//   interval : { everyMs }                                            —— 每 N 分/小时,从上次起算
//   once     : { atMs }                                               —— 单次:某个 UTC 毫秒时刻

const BEIJING_OFFSET_MS = 8 * 3_600_000;

// 定时执行失败后的指数退避重试:最多 5 次,退避 1→2→4→8→16 分钟(单次上限 20 分钟)。
export const MAX_AUTOMATION_RETRIES = 5;
// 周期任务的最小间隔：任务会联网调 LLM(最长 6 分钟)，间隔太短会把后台并发占满。
export const MIN_INTERVAL_MS = 10 * 60_000;
const RETRY_BASE_MS = 60_000;        // 首次重试 1 分钟后
const RETRY_CAP_MS = 20 * 60_000;    // 单次退避上限 20 分钟
/** 第 n 次重试前的退避时长(n 从 0 起:0→1min,1→2min,…)。 */
export function retryDelayMs(retryCount: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, retryCount), RETRY_CAP_MS);
}

export type ScheduleKind = "cron" | "interval" | "once";
export interface CronConfig { weekdays: number[]; hour: number; minute: number }
export interface IntervalConfig { everyMs: number }
export interface OnceConfig { atMs: number }
export type ScheduleConfig = CronConfig | IntervalConfig | OnceConfig;

/** 校验 + 归一化 scheduleConfig(非法则抛错,供 API 层转 400)。 */
export function normalizeSchedule(kind: ScheduleKind, config: unknown): ScheduleConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  if (kind === "cron") {
    const weekdays = Array.isArray(c.weekdays) ? c.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7) : [];
    const hour = Number(c.hour), minute = Number(c.minute);
    if (weekdays.length === 0) throw new Error("cron: weekdays 不能为空");
    if (!(Number.isInteger(hour) && hour >= 0 && hour <= 23)) throw new Error("cron: hour 非法");
    if (!(Number.isInteger(minute) && minute >= 0 && minute <= 59)) throw new Error("cron: minute 非法");
    return { weekdays: Array.from(new Set(weekdays)).sort((a, b) => a - b), hour, minute };
  }
  if (kind === "interval") {
    const everyMs = Number(c.everyMs);
    if (!(Number.isFinite(everyMs) && everyMs >= MIN_INTERVAL_MS)) throw new Error("interval: everyMs 至少 600000(10 分钟)");
    return { everyMs: Math.floor(everyMs) };
  }
  if (kind === "once") {
    const atMs = Number(c.atMs);
    // JS Date 的合法范围是 ±8.64e15 ms,超出则 new Date 为 Invalid Date,落库时会 500。
    if (!Number.isFinite(atMs) || Math.abs(atMs) > 8.64e15) throw new Error("once: atMs 非法");
    return { atMs: Math.floor(atMs) };
  }
  throw new Error(`未知 scheduleKind: ${kind}`);
}

// 把北京墙钟(y-m-d h:m)转成真实 UTC 时刻(ms)。
function beijingWallToUtcMs(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo, d, h, mi, 0, 0) - BEIJING_OFFSET_MS;
}

/** 计算严格晚于 `now` 的下一次触发时刻;无有效下次(如单次已过)返回 null。
 *  effectiveFrom/To(可选,UTC ms):把触发限制在区间内;超过 to 返回 null。 */
export function computeNextRun(
  kind: ScheduleKind,
  config: ScheduleConfig,
  now: Date,
  bounds?: { from?: number | null; to?: number | null },
): Date | null {
  const nowMs = now.getTime();
  const lowerMs = Math.max(nowMs, bounds?.from ?? -Infinity);
  const toMs = bounds?.to ?? Infinity;

  let candMs: number | null = null;
  if (kind === "interval") {
    candMs = lowerMs + (config as IntervalConfig).everyMs;
  } else if (kind === "once") {
    const at = (config as OnceConfig).atMs;
    candMs = at > lowerMs ? at : null;
  } else {
    const cfg = config as CronConfig;
    const weekdays = new Set(cfg.weekdays);
    // 以 lowerMs 为基准找未来 8 天内第一个匹配「周几 + 时:分」的北京时刻。
    const anchor = new Date(lowerMs + BEIJING_OFFSET_MS); // getUTC* 字段 = 北京墙钟
    const y = anchor.getUTCFullYear(), mo = anchor.getUTCMonth(), d = anchor.getUTCDate();
    for (let add = 0; add <= 8; add++) {
      const utcMs = beijingWallToUtcMs(y, mo, d + add, cfg.hour, cfg.minute);
      if (utcMs <= lowerMs) continue;
      const wall = new Date(utcMs + BEIJING_OFFSET_MS);
      const isoDow = wall.getUTCDay() === 0 ? 7 : wall.getUTCDay(); // 1=周一..7=周日
      if (weekdays.has(isoDow)) { candMs = utcMs; break; }
    }
  }
  if (candMs === null || candMs > toMs) return null;
  return new Date(candMs);
}

const WD_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 人类可读的调度描述(列表展示用)。 */
export function describeSchedule(kind: ScheduleKind, config: ScheduleConfig): string {
  if (kind === "cron") {
    const c = config as CronConfig;
    const hm = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
    const wd = c.weekdays.length === 7 ? "每天"
      : c.weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => c.weekdays.includes(d)) ? "工作日"
      : "每" + c.weekdays.map((d) => WD_NAMES[d - 1]).join("、");
    return `${wd} ${hm}`;
  }
  if (kind === "interval") {
    const ms = (config as IntervalConfig).everyMs;
    return ms % 3_600_000 === 0 ? `每 ${ms / 3_600_000} 小时` : `每 ${Math.round(ms / 60_000)} 分钟`;
  }
  const at = new Date((config as OnceConfig).atMs + BEIJING_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `单次 ${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())} ${p(at.getUTCHours())}:${p(at.getUTCMinutes())}`;
}
