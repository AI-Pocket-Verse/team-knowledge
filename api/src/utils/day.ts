// 按北京日（UTC+8，无夏令时）分桶。活跃日记录（guards.ts → UserActiveDay.day）、
// 数据看板、周报共用同一口径，不随服务器时区变化。
import { beijingDayKey } from "./beijingWeek.js";

const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export { beijingDayKey };

// `n` 天前的北京 00:00 对应的 UTC 瞬时（n=0 → 北京今天 00:00）。
export function startOfBeijingDayMinus(from: Date, n: number): Date {
  const b = new Date(from.getTime() + OFFSET_MS); // 移到北京墙钟，再用 UTC getter 读取
  const midnightUtcMs = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - OFFSET_MS;
  return new Date(midnightUtcMs - n * DAY_MS);
}
