// 全站展示统一用北京时间(Asia/Shanghai,UTC+8 无夏令时)。
//
// 为什么固定时区而非用浏览器本地时区:服务端的「活跃天 / 近 N 天 / 周报」是按
// 北京日分桶的(部署已固定 TZ=Asia/Shanghai),若前端用访问者本地时区渲染墙钟
// 时间,跨时区访问者看到的"时刻"会与看板/周报的"天"错位。固定北京时区后,前后
// 端口径一致。
//
// 实现:Intl.DateTimeFormat 带 timeZone,与运行环境(浏览器/测试机)自身时区
// 无关 —— 输入是绝对瞬时(ISO/Date),输出恒为北京墙钟。
export const DISPLAY_TZ = "Asia/Shanghai";

// hourCycle:"h23" 强制 00–23(避免某些引擎在 hour12:false 下把午夜输出成 "24")。
const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface BeijingParts {
  year: string; // "2026"
  month: string; // "06"(已补零)
  day: string; // "10"
  hour: string; // "15"
  minute: string; // "05"
}

/** 把一个绝对瞬时拆成北京墙钟的各部分(均为补零字符串)。 */
export function beijingParts(date: Date): BeijingParts {
  const p = partsFmt.formatToParts(date);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === "24" ? "00" : hour, // 双保险,理论上 h23 已规避
    minute: get("minute"),
  };
}

/** 北京自然日键 "YYYY-MM-DD",用于"同一天"比较(不依赖运行环境时区)。 */
export function beijingDayKey(date: Date): string {
  const { year, month, day } = beijingParts(date);
  return `${year}-${month}-${day}`;
}
