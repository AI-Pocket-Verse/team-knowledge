// 北京时间(UTC+8,无夏令时)自然周计算。DB 里时间以 UTC 瞬时存储,这里把
// 「周一–周日」的边界换算为 UTC 瞬时,供周报按北京周聚合 + 定时调度使用。
const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 给定 UTC 瞬时,返回其北京日期 "YYYY-MM-DD"。
export function beijingDayKey(d: Date): string {
  const b = new Date(d.getTime() + OFFSET_MS); // 移到北京墙钟,再用 UTC getter 读取
  const y = b.getUTCFullYear();
  const m = String(b.getUTCMonth() + 1).padStart(2, "0");
  const day = String(b.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 该瞬时所在「北京自然周」的周一 00:00(北京)对应的 UTC 瞬时。
export function startOfBeijingWeek(d: Date): Date {
  const b = new Date(d.getTime() + OFFSET_MS);
  const dow = b.getUTCDay(); // 0=周日 .. 6=周六
  const isoDow = dow === 0 ? 7 : dow; // 1=周一 .. 7=周日
  // 当天北京 00:00 的 UTC 毫秒:北京日期 00:00 = UTC(Y-M-D 00:00) - OFFSET。
  const beijingMidnightUtcMs = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - OFFSET_MS;
  return new Date(beijingMidnightUtcMs - (isoDow - 1) * DAY_MS); // 回退到本周周一
}

export interface BeijingWeek {
  weekKey: string; // 周一北京日期 YYYY-MM-DD
  weekStart: Date; // 周一 00:00 北京(UTC 瞬时)
  weekEnd: Date; // 下周一 00:00 北京(UTC 瞬时,右开)
}

// 该瞬时所在的北京自然周。
export function beijingWeekOf(d: Date): BeijingWeek {
  const weekStart = startOfBeijingWeek(d);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
  return { weekKey: beijingDayKey(weekStart), weekStart, weekEnd };
}

// 「上一个完整周」—— d 所在北京周的前一周(周一–周日)。每周一 00:00 跑任务时
// d=now 落在新一周的周一,前一周正好是刚结束的完整周。
export function previousBeijingWeek(d: Date): BeijingWeek {
  const thisStart = startOfBeijingWeek(d);
  const prevStart = new Date(thisStart.getTime() - 7 * DAY_MS);
  return { weekKey: beijingDayKey(prevStart), weekStart: prevStart, weekEnd: thisStart };
}

// 一周 7 天的北京日期键(周一 → 周日),用于趋势分桶。
export function beijingWeekDayKeys(week: BeijingWeek): string[] {
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) keys.push(beijingDayKey(new Date(week.weekStart.getTime() + i * DAY_MS)));
  return keys;
}

// 距离下一个「周一 00:00(北京)」的毫秒数,用于定时任务自调度。
export function msUntilNextBeijingMonday(d: Date): number {
  const nextStart = new Date(startOfBeijingWeek(d).getTime() + 7 * DAY_MS);
  return Math.max(0, nextStart.getTime() - d.getTime());
}

/** 距离下一次「北京时间 某些星期几 hh:mm」的毫秒数,用于定时任务自调度。
 *  weekdays 用 ISO 编号:1=周一 … 7=周日。北京无夏令时,毫秒算术安全。 */
export function msUntilNextBeijing(weekdays: readonly number[], hour: number, minute: number, from: Date): number {
  const weekStart = startOfBeijingWeek(from).getTime(); // 本周一 00:00(北京)
  let best = Infinity;
  // 本周 + 下周的候选时刻里取「严格在 from 之后」的最近一个。
  for (let w = 0; w < 2; w++) {
    for (const d of weekdays) {
      const t = weekStart + (w * 7 + (d - 1)) * DAY_MS + (hour * 60 + minute) * 60_000;
      if (t > from.getTime() && t < best) best = t;
    }
  }
  return Math.max(0, best - from.getTime());
}

// 人类可读的周区间标签,如 "2026-06-01 ~ 2026-06-07"。时区口径(北京时间)由
// 展示处的上下文说明(列表说明文字 / 图片副标题),不再在标签里加「（北京时间）」括注。
export function beijingWeekLabel(week: BeijingWeek): string {
  const last = beijingDayKey(new Date(week.weekEnd.getTime() - DAY_MS)); // 周日
  return `${week.weekKey} ~ ${last}`;
}

// 工作周区间标签(周一 ~ 周五),用于周五发的周报卡片标题。
export function beijingWorkWeekLabel(week: BeijingWeek): string {
  const friday = beijingDayKey(new Date(week.weekStart.getTime() + 4 * DAY_MS)); // 周一 + 4 天 = 周五
  return `${week.weekKey} ~ ${friday}`;
}

/** 去掉文案里的「（北京时间）」括注(全/半角,可多处)。历史快照已把它写进
 *  weekLabel / summary,展示时(图片/卡片/页面)统一抹掉,与新生成的标签保持一致。 */
export function stripCnTz(s: string): string {
  return s.replace(/[（(]北京时间[）)]/g, "").trim();
}
