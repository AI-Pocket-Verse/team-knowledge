// 展示一律按北京时间(见 lib/tz.ts):"同一天" 的判断按北京自然日,跨时区
// 访问者与服务端口径一致。
import { beijingParts, beijingDayKey } from "./tz";

// WeChat-style timestamp grouping threshold. Two consecutive messages
// closer in time than this — AND on the same Beijing calendar day — share
// the timestamp of whichever batch they belong to: only the first one
// shows the divider, the rest stay clean. 10 minutes is the value we
// committed to; bump here if product wants a different feel later.
export const CHAT_TIMESTAMP_GROUP_GAP_MS = 10 * 60 * 1000;

// Should the chat-bubble list render a centered timestamp divider
// ABOVE the message at `curr`? Pass `prev = null` for the first row.
//
// Rules (any one triggers a show):
//   1. First message in the list (prev is null)
//   2. `curr` and `prev` fall on different Beijing calendar days — keeps
//      the date marker visible across midnight even when the time gap
//      is small (e.g. 23:55 → 00:03 next day)
//   3. Time gap from `prev` to `curr` exceeds 10 minutes
//
// Invalid input dates are treated as "definitely show" so a broken
// row doesn't accidentally hide every following divider.
export function shouldShowChatTimestamp(curr: string | Date, prev: string | Date | null): boolean {
  if (prev == null) return true;
  const c = curr instanceof Date ? curr : new Date(curr);
  const p = prev instanceof Date ? prev : new Date(prev);
  if (Number.isNaN(c.getTime()) || Number.isNaN(p.getTime())) return true;

  // 同一北京自然日?跨午夜时即便间隔很小也要显示日期标记。
  if (beijingDayKey(c) !== beijingDayKey(p)) return true;

  return c.getTime() - p.getTime() > CHAT_TIMESTAMP_GROUP_GAP_MS;
}

// Chat-bubble timestamp formatter.
//
//   - Today (same Beijing calendar day as `now`): "HH:mm"
//   - Otherwise:                                  "yyyy-MM-dd HH:mm"
//
// Inputs are ISO strings (`createdAt` from the API) or any Date-parseable
// value. 同一天按北京自然日比较,而非 UTC —— 昨晚 23:30 的消息即使 "今天 UTC"
// 还没翻篇也应显示日期。Invalid input → empty string so a broken row can't
// break the whole list.
export function formatChatTimestamp(iso: string | Date, now: Date = new Date()): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const { year, month, day, hour, minute } = beijingParts(d);
  const time = `${hour}:${minute}`;
  if (beijingDayKey(d) === beijingDayKey(now)) return time;
  return `${year}-${month}-${day} ${time}`;
}
