// Markdown-aware "字数" counter. Used at the end of the article reader to give
// readers a sense of how much they just consumed.
//
// Counting rule (字符数, matching Feishu / WeChat "字数"):
//   - Every VISIBLE character counts as 1 — CJK, Latin letters, digits AND
//     punctuation (so "111" = 3, "OAuth2" = 6, "你好，世界!" = 6).
//   - Counted by code point, so an emoji / surrogate pair counts as 1.
//   - Whitespace does NOT count.
//   - Code blocks and inline code are EXCLUDED entirely (a reader's "字数"
//     shouldn't be padded by code samples).
//   - Markdown markers don't count: heading `#`, list bullets / numbers,
//     blockquote `>`, emphasis `* _ ~ \``, horizontal rules, table pipes /
//     delimiter rows, image syntax, and link URLs (link TEXT still counts).
//
// Pure function with no React / DOM dependencies so it can be reused
// server-side or in tests without a JSDOM environment.
export function countArticleWords(md: string): number {
  if (!md) return 0;
  let s = md;
  // Drop fenced code (``` and ~~~) and inline code spans entirely.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  s = s.replace(/`[^`\n]+`/g, " ");
  // Image syntax — drop the whole `![alt](url)` blob; the alt text is rarely
  // meaningful prose and the URL definitely isn't.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // Inline link — keep the visible text, drop the URL.
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Block-level markers (per line): list bullets, ordered numbers, blockquote
  // arrows, heading hashes.
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  s = s.replace(/^\s*#{1,6}\s+/gm, "");
  // Whole lines made of only structural chars carry no prose: horizontal rules
  // (---/***/___) and table delimiter rows (|---|:--:|).
  s = s.replace(/^[\s|:*_-]+$/gm, " ");
  // Table cell separators in data rows (the cell TEXT between them still counts).
  s = s.replace(/\|/g, " ");
  // Inline emphasis / strikethrough / code markers — keep the wrapped text.
  s = s.replace(/[*_~`]/g, "");

  // 字数 = every remaining VISIBLE (non-whitespace) character, counted by code
  // point. `\s` covers ASCII + Unicode whitespace incl. full-width space (　).
  return Array.from(s.replace(/\s/g, "")).length;
}
