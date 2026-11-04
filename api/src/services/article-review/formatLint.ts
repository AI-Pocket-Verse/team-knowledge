// 确定性「格式预检」:不调 LLM,用规则扫出确定性的标题格式问题,作为 format 类 findings
// 注入复检结果(severity=med,不会被严重度阈值过滤)。LLM 校验偏「避免吹毛求疵」、又经两遍
// 取交集 + 阈值过滤,纯格式小毛病常被漏掉;这里用规则兜底,保证稳定检出。当前覆盖:
//   1) 标题里残留行内格式符号(** __ ` ~~ 或链接)—— 导入文档常见「## **标题**」;
//   2) 标题层级跳级(比上一个标题深超过一级,如 H1 直接到 H3)—— 会让大纲缩进错位。
import type { ReviewFinding } from "./findings.js";

interface ParsedHeading { level: number; text: string; }

// 解析 ATX 标题(# ~ ######),跳过围栏代码块内的 `#` 行(与前端大纲解析同源)。
function parseHeadings(body: string): ParsedHeading[] {
  const out: ParsedHeading[] = [];
  let inFence = false;
  let fence = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const fm = line.match(/^(```+|~~~+)/);
    if (fm) {
      if (!inFence) { inFence = true; fence = fm[1][0]; }
      else if (fm[1][0] === fence) { inFence = false; fence = ""; }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) out.push({ level: h[1].length, text: h[2] });
  }
  return out;
}

// 标题里出现这些 = 残留了行内格式语法(加粗 / 行内代码 / 删除线 / 链接)。
const HEADING_MARKER_RE = /\*\*|__|~~|`|\[[^\]]*\]\([^)]*\)/;

function truncate(s: string, max = 20): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 确定性标题格式预检。返回 format 类 findings(未带 hash,由调用方统一 hash + 去重)。 */
export function lintHeadingFormat(body: string): ReviewFinding[] {
  const headings = parseHeadings(body);
  const findings: ReviewFinding[] = [];

  // 1) 残留格式符号
  for (const h of headings) {
    if (HEADING_MARKER_RE.test(h.text)) {
      findings.push({
        category: "format",
        severity: "med",
        problem: `标题「${truncate(h.text)}」里残留了加粗/链接等格式符号`,
        suggestion: "去掉标题中的 ** __ ` ~~ 或链接语法,标题只保留纯文字",
      });
    }
  }

  // 2) 层级跳级(只看相邻标题向下跳超过一级;回到更高层级不算问题)
  let prev = 0;
  for (const h of headings) {
    if (prev > 0 && h.level > prev + 1) {
      findings.push({
        category: "format",
        severity: "med",
        problem: `标题「${truncate(h.text)}」层级跳级(上一级是 H${prev},这里直接到 H${h.level})`,
        suggestion: `把它改为 H${prev + 1},让标题层级逐级递进、大纲不错位`,
      });
    }
    prev = h.level;
  }

  return findings;
}
