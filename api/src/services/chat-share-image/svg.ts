// Chat-share image layout: selected chat messages → a chat-bubble SVG
// (user right / assistant left, rounded bubbles) that render.ts rasterizes to PNG.
// Light markdown (markdown.ts) is laid out inline-aware so **bold** / `code` /
// links / [#n] citations keep their styling inside wrapped lines.
//
// NOTE: we render text labels ("用户" / "assistant"), NOT emoji — the bundled font
// is Noto Sans SC (no emoji glyphs), so an emoji would rasterize as tofu.
import { esc, approxWidth, wrapText, text, rect } from "../weekly-report-image/helpers.js";
import { parseLightMarkdown, type Block, type InlineToken } from "./markdown.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";
import { L, appLang, type Lang } from "../../utils/lang.js";

export interface ChatShareMessage {
  role: "user" | "assistant";
  content: string;
  /** Attached images as ready-to-embed data URIs (the route resolves the
   *  user's /uploads/* urls → base64 before calling us, so svg.ts stays pure). */
  images?: string[];
}
export interface ChatShareOptions {
  title?: string;
  dateLabel?: string;
  /** 因过大或格式不支持没放进图里的附件张数,>0 时在末尾提示。 */
  skippedImages?: number;
  /** 界面语言(缺省 appLang())。 */
  lang?: Lang;
}

// ── Layout constants (px) ──
const W = 720;
const PAD = 28;                       // outer margin
const CONTENT_W = W - PAD * 2;        // 664
const MAX_BUBBLE_W = Math.round(CONTENT_W * 0.86); // ~571
const BUBBLE_PADX = 14;
const BUBBLE_PADY = 12;
const MAX_INNER_W = MAX_BUBBLE_W - BUBBLE_PADX * 2;
const MSG_GAP = 18;                   // vertical gap between messages
const LABEL_H = 20;                   // role label line above each bubble
const BODY_FS = 15;                   // paragraph/list font size
const BODY_LH = Math.round(BODY_FS * 1.55);
const CODE_FS = 13;
const CODE_LH = Math.round(CODE_FS * 1.5);
const MARKER_INDENT = 20;
const THUMB_W = 168;     // attached-image thumbnail box
const THUMB_H = 126;
const THUMB_GAP = 8;
// Hard ceiling on the logical canvas height. Bounds resvg's memory/CPU even if
// the route's char cap + rate limit are both maxed — past this we stop adding
// messages and append a truncation note. ~12k logical px → ≤ ~18k rasterized.
// 单条消息内部同样受此上限约束（见 layoutBody 的 maxHeight）。
const MAX_CANVAS_H = 12_000;
// 整张图最多绘制的正文字数。栅格化耗时几乎全花在逐字取字形轮廓上(内置 Noto Sans SC
// 约 1.8ms / 字,与缩放倍率无关),画布高度管不住它;超出部分截断并沿用截断提示。
const MAX_TEXT_CHARS = 6_000;

const COLOR = {
  fg: "#1d2129",
  muted: "#86909c",
  primary: "#3370ff",
  code: "#c2185b",
  userBubble: "#e8f1ff",
  assistantBubble: "#f2f3f5",
  codeBox: "#eceef1",
  quoteBar: "#c9cdd4",
  quoteFg: "#4e5969",
  divider: "#e5e6eb",
  headerSub: "#86909c",
};

type Style = InlineToken["t"];
interface Run { s: string; style: Style }
interface WrappedLine { runs: Run[]; width: number }

// Greedy char-by-char wrap that carries each char's inline style, grouping
// consecutive same-style chars into runs. CJK breaks anywhere (matches the
// project's wrapText); a line break ("\n") inside a token forces a new line.
function wrapInlines(inlines: InlineToken[], fontSize: number, maxWidth: number): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let runs: Run[] = [];
  let curStyle: Style | null = null;
  let curText = "";
  let width = 0;
  const flushRun = () => { if (curText) { runs.push({ s: curText, style: curStyle! }); curText = ""; } };
  const flushLine = () => { flushRun(); lines.push({ runs, width }); runs = []; width = 0; curStyle = null; };
  for (const tok of inlines) {
    const display = tok.t === "cite" ? `[${tok.s}]` : tok.s;
    for (const ch of display) {
      if (ch === "\n") { flushLine(); continue; }
      const cw = approxWidth(ch, fontSize);
      if (width > 0 && width + cw > maxWidth) flushLine();
      if (tok.t !== curStyle) { flushRun(); curStyle = tok.t; }
      curText += ch;
      width += cw;
    }
  }
  flushLine();
  return lines.length ? lines : [{ runs: [], width: 0 }];
}

// Single-line ellipsis so a long header title (up to 120 chars) can't overflow
// the fixed-width canvas. Uses the same approxWidth metric as the wrapper.
function ellipsize(s: string, fontSize: number, maxWidth: number): string {
  if (approxWidth(s, fontSize) <= maxWidth) return s;
  let out = "";
  for (const ch of s) {
    if (approxWidth(out + ch + "…", fontSize) > maxWidth) break;
    out += ch;
  }
  return out + "…";
}

function styleAttrs(style: Style): string {
  switch (style) {
    case "bold": return ' font-weight="600"';
    case "code": return ` fill="${COLOR.code}"`;
    case "link": return ` fill="${COLOR.primary}"`;
    case "cite": return ` fill="${COLOR.primary}" font-weight="600"`;
    default: return "";
  }
}

function lineMarkup(line: WrappedLine, x: number, baseline: number, fontSize: number, fill = COLOR.fg, weight = 400): string {
  const tspans = line.runs.map((r) => `<tspan${styleAttrs(r.style)}>${esc(r.s)}</tspan>`).join("");
  return `<text x="${x}" y="${baseline}" font-size="${fontSize}" fill="${fill}" font-weight="${weight}" font-family="Noto Sans SC">${tspans}</text>`;
}

// A single message body laid out into draw closures (positioned relative to the
// bubble's inner top-left, applied at render time). Returns total inner height
// and the widest rendered line (for shrink-to-fit bubble sizing).
interface BodyLayout { height: number; maxWidth: number; truncated: boolean; render: (x0: number, y0: number) => string }

// maxHeight：本条正文最多占用的高度。单条消息行数再多也不会把画布撑过上限，
// 超出的块/行直接丢弃，由调用方补一行截断提示。
function layoutBody(content: string, innerWidth: number, maxHeight: number, lang: Lang = appLang()): BodyLayout {
  const blocks = content.trim() ? parseLightMarkdown(content) : [{ t: "para", inlines: [{ t: "text", s: L(lang, "（无内容）", "(No content)") }] } as Block];
  const draws: Array<(x0: number, y0: number) => string> = [];
  let cy = 0;
  let maxW = 0;
  let first = true;
  let truncated = false;
  // 还能放下几行（行高 lh）；至少放 1 行，保证被截断的块仍有可见内容。
  const fit = <T>(lines: T[], lh: number): T[] => {
    const room = Math.max(1, Math.floor((maxHeight - cy) / lh));
    if (lines.length <= room) return lines;
    truncated = true;
    return lines.slice(0, room);
  };

  const headingSize = (lvl: 1 | 2 | 3) => (lvl === 1 ? 19 : lvl === 2 ? 17 : 15.5);

  for (const b of blocks) {
    if (cy >= maxHeight) { truncated = true; break; }
    if (!first) cy += b.t === "heading" ? 10 : 6; // inter-block gap
    first = false;

    if (b.t === "rule") {
      const ry = cy + 6;
      draws.push((x0, y0) => rect(x0, y0 + ry, innerWidth, 1, { fill: COLOR.divider }));
      cy += 13;
      continue;
    }

    if (b.t === "code") {
      const codeLines = b.lines.length ? b.lines : [""];
      const wrapped = fit(codeLines.flatMap((l) => wrapText(l || " ", CODE_FS, innerWidth - 20)), CODE_LH);
      const boxH = wrapped.length * CODE_LH + 16;
      const boxTop = cy;
      let lineW = 0;
      for (const l of wrapped) lineW = Math.max(lineW, approxWidth(l, CODE_FS));
      maxW = Math.max(maxW, Math.min(innerWidth, lineW + 20));
      draws.push((x0, y0) => {
        const parts = [rect(x0, y0 + boxTop, innerWidth, boxH, { fill: COLOR.codeBox, rx: 6 })];
        wrapped.forEach((l, idx) => {
          const baseline = y0 + boxTop + 8 + idx * CODE_LH + CODE_FS;
          parts.push(`<text x="${x0 + 10}" y="${baseline}" font-size="${CODE_FS}" fill="${COLOR.fg}" font-family="Noto Sans SC">${esc(l)}</text>`);
        });
        return parts.join("");
      });
      cy += boxH;
      continue;
    }

    if (b.t === "heading") {
      const fs = headingSize(b.level);
      const lh = Math.round(fs * 1.45);
      const lines = fit(wrapInlines(b.inlines, fs, innerWidth), lh);
      const top = cy;
      lines.forEach((l) => (maxW = Math.max(maxW, l.width)));
      draws.push((x0, y0) =>
        lines.map((l, idx) => lineMarkup(l, x0, y0 + top + idx * lh + fs, fs, COLOR.fg, 600)).join(""));
      cy += lines.length * lh;
      continue;
    }

    if (b.t === "quote") {
      const lines = fit(wrapInlines(b.inlines, BODY_FS, innerWidth - 14), BODY_LH);
      const top = cy;
      const h = lines.length * BODY_LH;
      lines.forEach((l) => (maxW = Math.max(maxW, l.width + 14)));
      draws.push((x0, y0) => {
        const parts = [rect(x0, y0 + top + 2, 3, h - 4, { fill: COLOR.quoteBar, rx: 1.5 })];
        lines.forEach((l, idx) => parts.push(lineMarkup(l, x0 + 14, y0 + top + idx * BODY_LH + BODY_FS, BODY_FS, COLOR.quoteFg)));
        return parts.join("");
      });
      cy += h;
      continue;
    }

    if (b.t === "bullet" || b.t === "ordered") {
      const lines = fit(wrapInlines(b.inlines, BODY_FS, innerWidth - MARKER_INDENT), BODY_LH);
      const top = cy;
      const marker = b.marker;
      lines.forEach((l) => (maxW = Math.max(maxW, MARKER_INDENT + l.width)));
      draws.push((x0, y0) => {
        const parts = [`<text x="${x0}" y="${y0 + top + BODY_FS}" font-size="${BODY_FS}" fill="${COLOR.fg}" font-family="Noto Sans SC">${esc(marker)}</text>`];
        lines.forEach((l, idx) => parts.push(lineMarkup(l, x0 + MARKER_INDENT, y0 + top + idx * BODY_LH + BODY_FS, BODY_FS)));
        return parts.join("");
      });
      cy += lines.length * BODY_LH;
      continue;
    }

    // paragraph
    const lines = fit(wrapInlines(b.inlines, BODY_FS, innerWidth), BODY_LH);
    const top = cy;
    lines.forEach((l) => (maxW = Math.max(maxW, l.width)));
    draws.push((x0, y0) =>
      lines.map((l, idx) => lineMarkup(l, x0, y0 + top + idx * BODY_LH + BODY_FS, BODY_FS)).join(""));
    cy += lines.length * BODY_LH;
  }

  return {
    height: cy,
    maxWidth: Math.min(innerWidth, Math.ceil(maxW)),
    truncated,
    render: (x0, y0) => draws.map((d) => d(x0, y0)).join(""),
  };
}

// Attached images → a wrapping grid of fixed thumbnail boxes. Each image fits
// inside its box via preserveAspectRatio="meet" (no crop, no distortion), so we
// don't need to decode image dimensions. data URIs are embedded as <image>.
interface ImagesLayout { height: number; width: number; render: (x0: number, y0: number) => string }
function layoutImages(images: string[], innerWidth: number): ImagesLayout {
  if (!images.length) return { height: 0, width: 0, render: () => "" };
  const perRow = Math.max(1, Math.floor((innerWidth + THUMB_GAP) / (THUMB_W + THUMB_GAP)));
  const cols = Math.min(images.length, perRow);
  const rows = Math.ceil(images.length / perRow);
  return {
    width: cols * THUMB_W + (cols - 1) * THUMB_GAP,
    height: rows * THUMB_H + (rows - 1) * THUMB_GAP,
    render: (x0, y0) =>
      images.map((uri, idx) => {
        const ix = x0 + (idx % perRow) * (THUMB_W + THUMB_GAP);
        const iy = y0 + Math.floor(idx / perRow) * (THUMB_H + THUMB_GAP);
        // Image first, then a soft rounded border on top.
        return `<image href="${esc(uri)}" x="${ix}" y="${iy}" width="${THUMB_W}" height="${THUMB_H}" preserveAspectRatio="xMidYMid meet" />`
          + rect(ix, iy, THUMB_W, THUMB_H, { fill: "none", stroke: COLOR.divider, rx: 8 });
      }).join(""),
  };
}

/** Build the chat-share SVG. Pure + deterministic (date is passed in via opts)
 *  so it's unit-testable without a clock. */
export function buildChatShareSvg(messages: ChatShareMessage[], opts: ChatShareOptions = {}): string {
  const lang = opts.lang ?? appLang();
  const title = opts.title?.trim() || L(lang, `${ASSISTANT_NAME} 对话摘录`, `${ASSISTANT_NAME} chat excerpt`);
  const sub = opts.dateLabel?.trim() || L(lang, `摘自 ${ASSISTANT_NAME} 对话`, `From a chat with ${ASSISTANT_NAME}`);

  const body: string[] = [];
  let y = PAD;

  // ── Header ──
  body.push(text(ellipsize(title, 18, CONTENT_W), PAD, y + 22, { size: 18, weight: 600, color: COLOR.fg }));
  body.push(text(sub, PAD, y + 44, { size: 12, color: COLOR.headerSub }));
  y += 60;
  body.push(rect(PAD, y, CONTENT_W, 1, { fill: COLOR.divider }));
  y += MSG_GAP;

  // ── Messages ──
  let truncated = false;
  let charBudget = MAX_TEXT_CHARS;
  for (const m of messages) {
    // Stop before the canvas grows unbounded (memory/CPU guard); note the cut.
    if (y > MAX_CANVAS_H) { truncated = true; break; }
    let content = m.content ?? "";
    if (content.trim() && charBudget <= 0) { truncated = true; break; }
    if (content.length > charBudget) {
      content = content.slice(0, charBudget);
      // 不切开代理对(emoji、生僻字),否则末尾会多出一个乱码字符。
      if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
      truncated = true;
      if (!content.trim()) break; // 预算用完:不要画出一个「（无内容）」气泡
    }
    charBudget -= content.length;
    const isUser = m.role === "user";
    const label = isUser ? L(lang, "用户", "User") : ASSISTANT_NAME;
    const imgs = layoutImages(m.images ?? [], MAX_INNER_W);
    const hasImages = imgs.height > 0;
    const hasText = content.trim().length > 0;
    // Image-only message: skip the body so we don't show a "（无内容）" placeholder
    // under the image. Otherwise lay out the (possibly-empty) text as before.
    const textLayout = hasText || !hasImages
      ? layoutBody(content, MAX_INNER_W, Math.max(BODY_LH, MAX_CANVAS_H - y), lang)
      : { height: 0, maxWidth: 0, truncated: false, render: () => "" };
    if (textLayout.truncated) truncated = true;
    const gapBetween = hasImages && textLayout.height > 0 ? 8 : 0;

    const innerW = Math.min(MAX_INNER_W, Math.max(40, imgs.width, textLayout.maxWidth));
    const bubbleW = innerW + BUBBLE_PADX * 2;
    const bubbleH = BUBBLE_PADY * 2 + imgs.height + gapBetween + textLayout.height;
    const bubbleX = isUser ? W - PAD - bubbleW : PAD;
    const labelAnchor = isUser ? "end" : "start";
    const labelX = isUser ? W - PAD : PAD;

    body.push(text(label, labelX, y + 13, { size: 12, color: COLOR.muted, anchor: labelAnchor as "start" | "end" }));
    const bubbleTop = y + LABEL_H;
    body.push(rect(bubbleX, bubbleTop, bubbleW, bubbleH, { fill: isUser ? COLOR.userBubble : COLOR.assistantBubble, rx: 12 }));
    const innerX = bubbleX + BUBBLE_PADX;
    const innerY = bubbleTop + BUBBLE_PADY;
    if (hasImages) body.push(imgs.render(innerX, innerY));
    body.push(textLayout.render(innerX, innerY + imgs.height + gapBetween));

    y = bubbleTop + bubbleH + MSG_GAP;
    // 本条正文已被截断：后面的消息不再放。
    if (textLayout.truncated) break;
  }

  if (truncated) {
    body.push(text(L(lang, "（内容较多，图片已截断；完整内容请用「分享到文档」）", "(Too long, so the image was truncated. Use \"Share to doc\" for the full content.)"), PAD, y + 14, { size: 12, color: COLOR.muted }));
    y += 28;
  }
  if (opts.skippedImages && opts.skippedImages > 0) {
    body.push(text(L(lang, `（${opts.skippedImages} 张附件图片过大或格式暂不支持，未放入图片）`, `(${opts.skippedImages} attached ${opts.skippedImages === 1 ? "image is" : "images are"} too large or in an unsupported format, so ${opts.skippedImages === 1 ? "it was" : "they were"} left out.)`), PAD, y + 14, { size: 12, color: COLOR.muted }));
    y += 28;
  }

  y += PAD - MSG_GAP; // bottom padding

  const H = Math.max(y, PAD * 2 + 60);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    rect(0, 0, W, H, { fill: "#ffffff" }),
    body.join(""),
    "</svg>",
  ].join("");
}
