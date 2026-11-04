// SVG 出图的纯函数 helper:无副作用、不依赖 DOM,便于单测。坐标系单位 = px。

/** XML 转义 —— 所有进入 SVG 文本/属性的「用户内容」(用户名/标题/概览)必须转义,
 *  否则一个含 < & 的名字就能破坏整张 SVG。 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 近似文本宽度(无字体度量):CJK/全角 ≈ 1em,其余 ≈ 0.6em。够用于折行与截断。 */
export function approxWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += (/[　-鿿＀-￯]/.test(ch) ? 1 : 0.6) * fontSize;
  return w;
}

/** 贪心折行(CJK 可在任意字符间断行)。返回每行字符串。 */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    const next = cur + ch;
    if (cur && approxWidth(next, fontSize) > maxWidth) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** 线性比例尺 value(0..domainMax) → px(0..rangePx)。domainMax≤0 时恒 0(防 NaN)。 */
export function linScale(domainMax: number, rangePx: number): (v: number) => number {
  if (domainMax <= 0) return () => 0;
  return (v: number) => (v / domainMax) * rangePx;
}

/** 极坐标 → 笛卡尔(0° = 12 点方向,顺时针为正)。 */
export function polar(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** 环形扇区(donut slice)的 path d:外弧 → 内弧闭合。startDeg<endDeg。 */
export function donutSlicePath(
  cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, endDeg: number,
): string {
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const o1 = polar(cx, cy, rOuter, startDeg);
  const o2 = polar(cx, cy, rOuter, endDeg);
  const i2 = polar(cx, cy, rInner, endDeg);
  const i1 = polar(cx, cy, rInner, startDeg);
  return [
    `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
    `L ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/** <text>。anchor: start|middle|end;weight 600 加粗表头/数值。 */
export function text(
  content: string, x: number, y: number,
  o: { size?: number; color?: string; anchor?: "start" | "middle" | "end"; weight?: number } = {},
): string {
  const { size = 13, color = "#1d2129", anchor = "start", weight = 400 } = o;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}" font-family="Noto Sans SC">${esc(content)}</text>`;
}

/** 圆角矩形(卡片/表格底色等)。 */
export function rect(
  x: number, y: number, w: number, h: number,
  o: { fill?: string; stroke?: string; rx?: number } = {},
): string {
  const { fill = "#ffffff", stroke = "none", rx = 0 } = o;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" />`;
}
