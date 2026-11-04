// article-review 运行参数(管理后台可配;复用 Setting 键值存储)。
//   enabled         总开关(默认关)
//   scanIntervalSec 扫描间隔(秒);调度器每个周期读一次,改动下个周期生效
//   idleMinutes     静置阈值(分钟);每轮读一次,改动即时生效
import { getSetting, setSetting } from "../settings.js";
import type { ReviewSeverity } from "./findings.js";

const ENABLED_KEY = "article-review.enabled";
const SCAN_INTERVAL_KEY = "article-review.scan_interval_sec";
const IDLE_MINUTES_KEY = "article-review.idle_minutes";
const MIN_SEVERITY_KEY = "article-review.min_severity";
// 每日复检提醒:仍有未优化问题的文档,按工作日定时飞书提醒最后编辑者(直到修复/忽略)。
const REMINDER_ENABLED_KEY = "article-review.reminder_enabled";
const REMINDER_HOUR_KEY = "article-review.reminder_hour";
const REMINDER_MINUTE_KEY = "article-review.reminder_minute";
const REMINDER_WEEKDAYS_KEY = "article-review.reminder_weekdays";

// 默认与边界(防误填:间隔过小会狂刷 LLM,过大形同关闭)。
export const SCAN_INTERVAL_DEFAULT_SEC = 120;
export const SCAN_INTERVAL_MIN_SEC = 30;
export const SCAN_INTERVAL_MAX_SEC = 3600;
export const IDLE_DEFAULT_MIN = 10;
export const IDLE_MIN_MIN = 1;
export const IDLE_MAX_MIN = 1440;

// 严重度阈值:低于此级别的问题不点亮徽标(默认 "med" = 过滤掉 low 级吹毛求疵)。
// "low" = 不过滤(全部上报);"high" = 仅最严重。
export const MIN_SEVERITY_DEFAULT: ReviewSeverity = "med";
const SEVERITY_VALUES: ReviewSeverity[] = ["low", "med", "high"];

// 提醒默认:每工作日(周一~周五)10:00。weekdays 用 ISO 1=周一..7=周日。
export const REMINDER_HOUR_DEFAULT = 10;
export const REMINDER_MINUTE_DEFAULT = 0;
export const REMINDER_WEEKDAYS_DEFAULT = [1, 2, 3, 4, 5];

/** 归一化星期集合:保留 1..7、去重升序;为空/非法回退默认(工作日)。纯函数,便于测。 */
export function normalizeWeekdays(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  const out = arr.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return out.length ? Array.from(new Set(out)).sort((a, b) => a - b) : [...REMINDER_WEEKDAYS_DEFAULT];
}

/** 取整 + 夹到 [min,max];非法值(布尔/数组/空串/null 等)回退默认。纯函数,便于测。 */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  // 只接受数字或「非空数字字符串」;其余(boolean/null/[]/""/对象)一律回退默认,
  // 避免 Number(true)=1 / Number("")=0 这类强转把垃圾值悄悄夹成 min。
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface ReviewSettings {
  enabled: boolean;
  scanIntervalSec: number;
  idleMinutes: number;
  minSeverity: ReviewSeverity;
  reminderEnabled: boolean;
  reminderHour: number;      // 0-23(北京时间)
  reminderMinute: number;    // 0-59
  reminderWeekdays: number[]; // 1=周一..7=周日
}

export interface ReminderSettings {
  reminderEnabled: boolean;
  reminderHour: number;
  reminderMinute: number;
  reminderWeekdays: number[];
}

export async function getReviewEnabled(): Promise<boolean> {
  return getSetting<boolean>(ENABLED_KEY, false);
}

export async function setReviewEnabled(enabled: boolean, by: string): Promise<void> {
  await setSetting(ENABLED_KEY, enabled, by);
}

export async function getScanIntervalSec(): Promise<number> {
  return clampInt(await getSetting(SCAN_INTERVAL_KEY, SCAN_INTERVAL_DEFAULT_SEC), SCAN_INTERVAL_MIN_SEC, SCAN_INTERVAL_MAX_SEC, SCAN_INTERVAL_DEFAULT_SEC);
}

export async function getIdleMinutes(): Promise<number> {
  return clampInt(await getSetting(IDLE_MINUTES_KEY, IDLE_DEFAULT_MIN), IDLE_MIN_MIN, IDLE_MAX_MIN, IDLE_DEFAULT_MIN);
}

/** 严重度阈值;非法值(历史脏数据/越界)回退默认。 */
export async function getMinSeverity(): Promise<ReviewSeverity> {
  const v = await getSetting<unknown>(MIN_SEVERITY_KEY, MIN_SEVERITY_DEFAULT);
  return SEVERITY_VALUES.includes(v as ReviewSeverity) ? (v as ReviewSeverity) : MIN_SEVERITY_DEFAULT;
}

/** 提醒总开关(调度器每跳先读它早退,避免关闭时每分钟白读 4 个配置)。 */
export async function getReminderEnabled(): Promise<boolean> {
  return getSetting<boolean>(REMINDER_ENABLED_KEY, false);
}

/** 每日提醒配置(reminder.ts 与调度器用);非法值夹紧/回退默认。 */
export async function getReminderSettings(): Promise<ReminderSettings> {
  const [reminderEnabled, hour, minute, weekdays] = await Promise.all([
    getReminderEnabled(),
    getSetting(REMINDER_HOUR_KEY, REMINDER_HOUR_DEFAULT),
    getSetting(REMINDER_MINUTE_KEY, REMINDER_MINUTE_DEFAULT),
    getSetting<unknown>(REMINDER_WEEKDAYS_KEY, REMINDER_WEEKDAYS_DEFAULT),
  ]);
  return {
    reminderEnabled,
    reminderHour: clampInt(hour, 0, 23, REMINDER_HOUR_DEFAULT),
    reminderMinute: clampInt(minute, 0, 59, REMINDER_MINUTE_DEFAULT),
    reminderWeekdays: normalizeWeekdays(weekdays),
  };
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  const [enabled, scanIntervalSec, idleMinutes, minSeverity, reminder] = await Promise.all([
    getReviewEnabled(), getScanIntervalSec(), getIdleMinutes(), getMinSeverity(), getReminderSettings(),
  ]);
  return { enabled, scanIntervalSec, idleMinutes, minSeverity, ...reminder };
}

/** 部分更新(只写传入的字段);数值越界自动夹紧、严重度非法回退默认。返回更新后的完整设置。 */
export async function setReviewSettings(
  patch: {
    enabled?: boolean; scanIntervalSec?: number; idleMinutes?: number; minSeverity?: ReviewSeverity;
    reminderEnabled?: boolean; reminderHour?: number; reminderMinute?: number; reminderWeekdays?: number[];
  },
  by: string,
): Promise<ReviewSettings> {
  if (patch.enabled !== undefined) await setReviewEnabled(patch.enabled, by);
  if (patch.scanIntervalSec !== undefined) {
    await setSetting(SCAN_INTERVAL_KEY, clampInt(patch.scanIntervalSec, SCAN_INTERVAL_MIN_SEC, SCAN_INTERVAL_MAX_SEC, SCAN_INTERVAL_DEFAULT_SEC), by);
  }
  if (patch.idleMinutes !== undefined) {
    await setSetting(IDLE_MINUTES_KEY, clampInt(patch.idleMinutes, IDLE_MIN_MIN, IDLE_MAX_MIN, IDLE_DEFAULT_MIN), by);
  }
  if (patch.minSeverity !== undefined) {
    const v = SEVERITY_VALUES.includes(patch.minSeverity) ? patch.minSeverity : MIN_SEVERITY_DEFAULT;
    await setSetting(MIN_SEVERITY_KEY, v, by);
  }
  if (patch.reminderEnabled !== undefined) await setSetting(REMINDER_ENABLED_KEY, patch.reminderEnabled, by);
  if (patch.reminderHour !== undefined) await setSetting(REMINDER_HOUR_KEY, clampInt(patch.reminderHour, 0, 23, REMINDER_HOUR_DEFAULT), by);
  if (patch.reminderMinute !== undefined) await setSetting(REMINDER_MINUTE_KEY, clampInt(patch.reminderMinute, 0, 59, REMINDER_MINUTE_DEFAULT), by);
  if (patch.reminderWeekdays !== undefined) await setSetting(REMINDER_WEEKDAYS_KEY, normalizeWeekdays(patch.reminderWeekdays), by);
  return getReviewSettings();
}
