// Compact zh date + relative-time formatters shared by the dashboard and
// the profile activity feed so "最近活跃 / 动态时间" read identically.
//
// 展示一律按北京时间(见 lib/tz.ts),与服务端按北京日分桶的看板/周报口径一致。
import { beijingParts } from "./tz";

export function fmtDate(iso: string): string {
  const { year, month, day } = beijingParts(new Date(iso));
  return `${year}-${month}-${day}`;
}

// yyyy-mm-dd HH:mm(24h,北京时间)— used where a precise timestamp reads
// better than a bare date (e.g. the article meta row under the title).
export function fmtDateTime(iso: string): string {
  const { year, month, day, hour, minute } = beijingParts(new Date(iso));
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function fmtRelativeTime(iso: string | null): string {
  if (!iso) return "从未";
  // 相对差值基于绝对瞬时,与时区无关;仅 >30 天回退到的 fmtDate 才涉及北京日历。
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDate(iso);
}
