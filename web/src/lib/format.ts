// 展示一律按北京时间(见 lib/tz.ts)。
import { beijingParts } from "./tz";

/**
 * Format an ISO timestamp as `yyyy-MM-dd HH:mm:ss` in Beijing time
 * (Asia/Shanghai, UTC+8). Centralised here so the article list cards and the
 * comment thread always show the same shape; previously each
 * component had its own copy and they would have drifted.
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const { year, month, day, hour, minute } = beijingParts(d);
  // Seconds: Intl partsFmt in tz.ts omits seconds — derive from the
  // absolute instant directly (offset from UTC is irrelevant for seconds).
  const sec = String(d.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${sec}`;
}

/**
 * 去掉文案里的「（北京时间）」括注(全/半角)。周报口径(北京时间)已由页面说明文字
 * 表达,周区间标签里不再重复;历史持久化快照的 weekLabel/summary 仍可能带括注,
 * 展示时统一抹掉,与后端新生成的标签保持一致。后端同名工具见 api 的 beijingWeek.ts。
 */
export function stripCnTz(s: string): string {
  return s.replace(/[（(]北京时间[）)]/g, "").trim();
}
