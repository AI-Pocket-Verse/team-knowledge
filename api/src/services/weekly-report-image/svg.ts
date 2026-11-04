import type { WeeklyReportSnapshot } from "@team-knowledge/shared";
import { stripCnTz } from "../../utils/beijingWeek.js";
import { esc, approxWidth, wrapText, linScale, donutSlicePath, text, rect } from "./helpers.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

const W = 900;
const PAD = 24;
const CW = W - PAD * 2; // 内容宽 852
const PALETTE = ["#3370FF", "#00B42A", "#FF7D00", "#F53F3F", "#7B61FF", "#0FC6C2", "#165DFF", "#D91AD9", "#86909C", "#FFC53D"];

interface Block { markup: string; height: number; }

// ── 折线系列(对应 trends 字段)──
const TREND_SERIES = [
  { key: "docCreate", label: "新建", color: "#3370FF" },
  { key: "docEdit", label: "修改", color: "#00B42A" },
  { key: "chat", label: "提问", color: "#FF7D00" },
  { key: "comment", label: "评论", color: "#F53F3F" },
  { key: "like", label: "点赞", color: "#7B61FF" },
  { key: "view", label: "查看", color: "#0FC6C2" },
  { key: "activeUsers", label: "活跃用户", color: "#86909C" },
] as const;

function fmtHours(min: number): string { return `${(min / 60).toFixed(1)} 小时`; }
const num = (t: WeeklyReportSnapshot["trends"][number], key: string): number =>
  (t as unknown as Record<string, number>)[key] ?? 0;

function header(s: WeeklyReportSnapshot, y: number): Block {
  const m = [
    text(`知识库周报 · ${stripCnTz(s.weekLabel)}`, PAD, y + 26, { size: 20, weight: 600 }),
    text("按北京时间自然周(周一–周日)统计", PAD, y + 48, { size: 12, color: "#86909c" }),
  ].join("");
  return { markup: m, height: 60 };
}

function summaryBlock(s: WeeklyReportSnapshot, y: number): Block {
  if (!s.summary) return { markup: "", height: 0 };
  const size = 14;
  const lines = wrapText(stripCnTz(s.summary), size, CW - 32);
  const boxH = 16 + lines.length * (size + 8);
  const m = [
    rect(PAD, y, CW, boxH, { fill: "#f7f9fc", stroke: "#eef1f5", rx: 10 }),
    ...lines.map((ln, i) => text(ln, PAD + 16, y + 24 + i * (size + 8), { size, color: "#4e5969" })),
  ].join("");
  return { markup: m, height: boxH + 12 };
}

function overviewCards(s: WeeklyReportSnapshot, y: number): Block {
  const o = s.overview;
  const cards = [
    { label: "活跃用户", value: String(o.activeUsers) },
    { label: "在线总时长", value: fmtHours(o.totalDurationMin) },
    { label: "新建文档", value: String(o.docCreate) },
    { label: "修改文档", value: String(o.docEdit) },
    { label: `向 ${ASSISTANT_NAME} 提问`, value: String(o.chat) },
    { label: "评论", value: String(o.comment) },
    { label: "点赞", value: String(o.like) },
    { label: "查看文档", value: String(o.view) },
  ];
  const cols = 4, gap = 12;
  const cw = (CW - gap * (cols - 1)) / cols;
  const ch = 72;
  const parts: string[] = [text("本周概览", PAD, y + 4, { size: 15, weight: 600 })];
  cards.forEach((c, i) => {
    const cx = PAD + (i % cols) * (cw + gap);
    const cy = y + 16 + Math.floor(i / cols) * (ch + gap);
    parts.push(rect(cx, cy, cw, ch, { fill: "#fff", stroke: "#eef1f5", rx: 12 }));
    parts.push(text(c.label, cx + 14, cy + 26, { size: 12, color: "#86909c" }));
    parts.push(text(c.value, cx + 14, cy + 52, { size: 22, weight: 600 }));
  });
  const rows = Math.ceil(cards.length / cols);
  return { markup: parts.join(""), height: 16 + rows * (ch + gap) + 8 };
}

function lineChart(s: WeeklyReportSnapshot, y: number): Block {
  const titleH = 24, chartH = 220, legendH = 28;
  const x0 = PAD + 36, x1 = PAD + CW - 8;
  const yTop = y + titleH + 6, yBot = yTop + chartH - 30;
  const days = s.trends.map((t) => t.day);
  const maxV = Math.max(1, ...s.trends.flatMap((t) => TREND_SERIES.map((ser) => num(t, ser.key))));
  const sy = linScale(maxV, yBot - yTop);
  const xAt = (i: number) => x0 + (days.length <= 1 ? 0 : (i / (days.length - 1)) * (x1 - x0));
  const parts: string[] = [text("每日活动趋势", PAD, y + 16, { size: 15, weight: 600 })];
  parts.push(`<line x1="${x0}" y1="${yBot}" x2="${x1}" y2="${yBot}" stroke="#eef1f5" />`);
  parts.push(text("0", x0 - 8, yBot + 4, { size: 10, color: "#c9cdd4", anchor: "end" }));
  parts.push(text(String(maxV), x0 - 8, yTop + 4, { size: 10, color: "#c9cdd4", anchor: "end" }));
  days.forEach((d, i) => parts.push(text(d.slice(5), xAt(i), yBot + 16, { size: 10, color: "#86909c", anchor: "middle" })));
  for (const ser of TREND_SERIES) {
    const pts = s.trends.map((t, i) => `${xAt(i).toFixed(1)},${(yBot - sy(num(t, ser.key))).toFixed(1)}`).join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="${ser.color}" stroke-width="2" />`);
  }
  let lx = PAD;
  const ly = y + titleH + chartH + 4;
  for (const ser of TREND_SERIES) {
    parts.push(rect(lx, ly - 8, 10, 10, { fill: ser.color, rx: 2 }));
    parts.push(text(ser.label, lx + 14, ly + 1, { size: 11, color: "#4e5969" }));
    lx += 14 + approxWidth(ser.label, 11) + 18;
  }
  return { markup: parts.join(""), height: titleH + chartH + legendH };
}

function donutChart(s: WeeklyReportSnapshot, y: number): Block {
  const titleH = 24;
  const slices = s.composition.filter((c) => c.count > 0);
  const total = slices.reduce((n, c) => n + c.count, 0);
  if (total === 0) {
    return { markup: text("行为构成", PAD, y + 16, { size: 15, weight: 600 }) + text("本周暂无行为数据", PAD, y + 44, { size: 12, color: "#86909c" }), height: titleH + 40 };
  }
  const cx = PAD + 90, cy = y + titleH + 100, rO = 80, rI = 44;
  const parts: string[] = [text("行为构成", PAD, y + 16, { size: 15, weight: 600 })];
  if (slices.length === 1) {
    // 单一类别 = 整圈:0°→360° 弧首尾点重合会退化成空,改画两个同心圆成环。
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${rO}" fill="${PALETTE[0]}" />`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${rI}" fill="#ffffff" />`);
  } else {
    let acc = 0;
    slices.forEach((c, i) => {
      const start = (acc / total) * 360;
      acc += c.count;
      const end = (acc / total) * 360;
      parts.push(`<path d="${donutSlicePath(cx, cy, rO, rI, start, Math.max(start + 0.5, end))}" fill="${PALETTE[i % PALETTE.length]}" />`);
    });
  }
  let ly = y + titleH + 30;
  slices.forEach((c, i) => {
    parts.push(rect(cx + 110, ly - 9, 10, 10, { fill: PALETTE[i % PALETTE.length], rx: 2 }));
    parts.push(text(`${c.label} · ${c.count}`, cx + 124, ly, { size: 12, color: "#4e5969" }));
    ly += 20;
  });
  return { markup: parts.join(""), height: titleH + 210 };
}

function barChart(s: WeeklyReportSnapshot, y: number): Block {
  const titleH = 24;
  const rows = s.topContributors;
  if (rows.length === 0) {
    return { markup: text("贡献度 Top", PAD, y + 16, { size: 15, weight: 600 }) + text("本周暂无贡献数据", PAD, y + 44, { size: 12, color: "#86909c" }), height: titleH + 40 };
  }
  const labelW = 110, barX = PAD + labelW, barMaxW = CW - labelW - 60;
  const maxV = Math.max(1, ...rows.map((r) => r.contribution));
  const sx = linScale(maxV, barMaxW);
  const rh = 26, gap = 8;
  const parts: string[] = [text("贡献度 Top", PAD, y + 16, { size: 15, weight: 600 })];
  rows.forEach((r, i) => {
    const ry = y + titleH + 6 + i * (rh + gap);
    parts.push(text(r.name.length > 7 ? r.name.slice(0, 7) + "…" : r.name, PAD + labelW - 8, ry + rh / 2 + 4, { size: 12, anchor: "end" }));
    const bw = Math.max(2, sx(r.contribution));
    parts.push(rect(barX, ry, bw, rh, { fill: "#3370FF", rx: 4 }));
    parts.push(text(String(r.contribution), barX + bw + 6, ry + rh / 2 + 4, { size: 12, color: "#4e5969" }));
  });
  return { markup: parts.join(""), height: titleH + 6 + rows.length * (rh + gap) + 8 };
}

function userTable(s: WeeklyReportSnapshot, y: number): Block {
  const titleH = 24;
  if (s.users.length === 0) {
    return { markup: text("用户使用明细", PAD, y + 16, { size: 15, weight: 600 }) + text("本周暂无用户活动", PAD, y + 44, { size: 12, color: "#86909c" }), height: titleH + 40 };
  }
  type Row = WeeklyReportSnapshot["users"][number];
  const cols: Array<{ h: string; w: number; get: (u: Row, i: number) => string; anchor: "start" | "end" }> = [
    { h: "#", w: 32, get: (_u, i) => String(i + 1), anchor: "start" },
    { h: "用户", w: 120, get: (u) => (u.name.length > 8 ? u.name.slice(0, 8) + "…" : u.name), anchor: "start" },
    { h: "贡献度", w: 70, get: (u) => String(u.contribution), anchor: "end" },
    { h: "在线时长", w: 84, get: (u) => fmtHours(u.durationMin), anchor: "end" },
    { h: "活跃天", w: 60, get: (u) => String(u.activeDays), anchor: "end" },
    { h: "新建", w: 56, get: (u) => String(u.docCreate), anchor: "end" },
    { h: "修改", w: 56, get: (u) => String(u.docEdit), anchor: "end" },
    { h: "提问", w: 56, get: (u) => String(u.chat), anchor: "end" },
    { h: "评论", w: 56, get: (u) => String(u.comment), anchor: "end" },
    { h: "点赞", w: 56, get: (u) => String(u.like), anchor: "end" },
    { h: "查看", w: 56, get: (u) => String(u.view), anchor: "end" },
    { h: "操作", w: 56, get: (u) => String(u.ops), anchor: "end" },
  ];
  const rh = 28;
  const xOf = (ci: number) => PAD + cols.slice(0, ci).reduce((n, c) => n + c.w, 0);
  const parts: string[] = [text("用户使用明细", PAD, y + 16, { size: 15, weight: 600 })];
  const headY = y + titleH + 6;
  parts.push(rect(PAD, headY, CW, rh, { fill: "#fafbfc" }));
  cols.forEach((c, ci) => {
    const tx = c.anchor === "end" ? xOf(ci) + c.w - 8 : xOf(ci) + 8;
    parts.push(text(c.h, tx, headY + 18, { size: 11, color: "#86909c", weight: 600, anchor: c.anchor }));
  });
  s.users.forEach((u, ri) => {
    const ry = headY + rh + ri * rh;
    if (ri % 2 === 1) parts.push(rect(PAD, ry, CW, rh, { fill: "#f7f9fc" }));
    cols.forEach((c, ci) => {
      const tx = c.anchor === "end" ? xOf(ci) + c.w - 8 : xOf(ci) + 8;
      parts.push(text(c.get(u, ri), tx, ry + 18, { size: 11, color: "#1d2129", anchor: c.anchor }));
    });
  });
  return { markup: parts.join(""), height: titleH + 6 + rh + s.users.length * rh + 8 };
}

function emptyReport(s: WeeklyReportSnapshot): string {
  const h = 160;
  const body = [
    rect(0, 0, W, h, { fill: "#ffffff" }),
    text(`知识库周报 · ${stripCnTz(s.weekLabel)}`, PAD, 44, { size: 20, weight: 600 }),
    text("本周暂无活动记录。", PAD, 88, { size: 14, color: "#4e5969" }),
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${body}</svg>`;
}

/** 把一份周报快照渲成一张定宽 900 的长图 SVG(标题/概览/折线/饼图/贡献榜/明细表)。 */
export function buildReportSvg(s: WeeklyReportSnapshot): string {
  if (s.overview.activeUsers === 0) return emptyReport(s);
  const blocks: Block[] = [];
  let y = PAD;
  const push = (b: Block) => { blocks.push({ markup: b.markup, height: b.height }); y += b.height + 16; };
  push(header(s, y));
  push(summaryBlock(s, y));
  push(overviewCards(s, y));
  push(lineChart(s, y));
  push(donutChart(s, y));
  push(barChart(s, y));
  push(userTable(s, y));
  const H = y + PAD - 16;
  const bg = rect(0, 0, W, H, { fill: "#ffffff" });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bg}${blocks.map((b) => b.markup).join("")}</svg>`;
}
