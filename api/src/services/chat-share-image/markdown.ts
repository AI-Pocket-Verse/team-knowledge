// Light markdown → block structure for the chat-share image. Pure, no DOM —
// the SVG layout (svg.ts) consumes Block[] and lays each block out as wrapped
// lines. We intentionally support only the subset that shows up in assistant chat:
// headings, ordered/unordered lists, fenced code, blockquotes, and inline
// **bold** / `code` / [text](url) links / [#n] citations. Anything else falls
// through as plain text — "light" by design.

export type InlineToken =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "code"; s: string }      // inline `code`
  | { t: "link"; s: string }      // display text only (url dropped)
  | { t: "cite"; s: string };     // [#n] → s = "n"

export type Block =
  | { t: "heading"; level: 1 | 2 | 3; inlines: InlineToken[] }
  | { t: "para"; inlines: InlineToken[] }
  | { t: "bullet"; marker: string; inlines: InlineToken[] }   // marker = "•"
  | { t: "ordered"; marker: string; inlines: InlineToken[] }  // marker = "1."
  | { t: "code"; lines: string[] }                            // fenced block, raw
  | { t: "quote"; inlines: InlineToken[] }
  | { t: "rule" };

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const RULE_RE = /^\s*([-*_])\1{2,}\s*$/;
const FENCE_RE = /^\s*```/;

// Inline matcher: image | inline-code | bold | citation | link. Image FIRST so
// `![alt](url)` isn't mis-parsed as a "!" + link; code before bold so `**` inside
// a code span isn't bolded. Order in the alternation = match priority.
const INLINE_RE = /(!\[[^\]\n]*\]\([^)\n]+\))|(`[^`]+`)|(\*\*[^*\n]+\*\*)|(\[#\d+\])|(\[[^\]\n]+\]\([^)\n]+\))/g;

/** Tokenize one line of text into styled inline runs. */
export function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(line)) !== null) {
    if (m.index > last) tokens.push({ t: "text", s: line.slice(last, m.index) });
    const raw = m[0];
    if (raw.startsWith("![")) {
      // Image markdown: the attached images render separately as thumbnails, so
      // drop the inline ![alt](url) entirely instead of leaking "!" + alt text.
    } else if (raw.startsWith("`")) {
      tokens.push({ t: "code", s: raw.slice(1, -1) });
    } else if (raw.startsWith("**")) {
      tokens.push({ t: "bold", s: raw.slice(2, -2) });
    } else if (/^\[#\d+\]$/.test(raw)) {
      tokens.push({ t: "cite", s: raw.slice(2, -1) }); // strip "[#" and "]"
    } else {
      // [text](url) → keep the display text only.
      const text = raw.slice(1, raw.indexOf("]"));
      tokens.push({ t: "link", s: text });
    }
    last = m.index + raw.length;
  }
  if (last < line.length) tokens.push({ t: "text", s: line.slice(last) });
  return tokens.length ? tokens : [{ t: "text", s: "" }];
}

/** Parse light markdown into blocks. Each non-blank line maps to one block;
 *  blank lines are dropped (the layout adds inter-block spacing). Hard line
 *  breaks in chat content are preserved (no soft-wrap merging). */
export function parseLightMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code block: collect raw lines until the closing fence (or EOF).
    if (FENCE_RE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) { code.push(lines[i]!); i++; }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ t: "code", lines: code });
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    if (RULE_RE.test(line)) { blocks.push({ t: "rule" }); i++; continue; }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ t: "heading", level: heading[1]!.length as 1 | 2 | 3, inlines: parseInline(heading[2]!) });
      i++; continue;
    }
    const quote = QUOTE_RE.exec(line);
    if (quote) { blocks.push({ t: "quote", inlines: parseInline(quote[1]!) }); i++; continue; }
    const ordered = ORDERED_RE.exec(line);
    if (ordered) { blocks.push({ t: "ordered", marker: `${ordered[1]}.`, inlines: parseInline(ordered[2]!) }); i++; continue; }
    const bullet = BULLET_RE.exec(line);
    if (bullet) { blocks.push({ t: "bullet", marker: "•", inlines: parseInline(bullet[1]!) }); i++; continue; }
    blocks.push({ t: "para", inlines: parseInline(line) });
    i++;
  }
  return blocks;
}
