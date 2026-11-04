// Extract a focused window of `body` centered on the first occurrence
// of any meaningful token in `query`. Falls back to "first windowSize
// chars" when nothing matches (better than nothing — still gives the
// LLM the doc's intro).
//
// We use this on noise-tier retrieval hits (FTS results, @folder /
// @role auto-loaded articles) where the user isn't asking about the
// whole document — just whatever portion is relevant to their query.
// High-priority items (active article, explicit @doc mention) get the
// full body capped at BODY_CAP because the user is explicitly
// focused on that doc as a whole.
//
// Window size default: 2500 chars (≈1500-2000 tokens) — enough for a
// few paragraphs of context around the match.
const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "我", "你", "他", "她", "它", "吗", "呢", "啊",
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "and", "or",
  "for", "on", "at", "be", "this", "that", "it", "with", "as", "by", "from",
]);

// Tokenize a Chinese/English mixed query into searchable chunks.
// Single-character Chinese terms are surfaced (Chinese FTS works
// char-by-char); English terms must be >=2 chars to skip noise.
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  // ASCII word runs
  for (const m of query.matchAll(/[A-Za-z0-9]+/g)) {
    const w = m[0].toLowerCase();
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
  }
  // Each CJK character is its own search term (cheap + matches FTS5
  // trigram intent without pulling in a full word segmenter)
  for (const m of query.matchAll(/[一-鿿]/g)) {
    const w = m[0];
    if (!STOPWORDS.has(w)) tokens.push(w);
  }
  // Dedupe, preserve order
  return Array.from(new Set(tokens));
}

export function extractSnippet(body: string, query: string, windowSize: number = 2500): string {
  if (body.length <= windowSize) return body;
  const lower = body.toLowerCase();
  const tokens = tokenize(query);
  // Find earliest match across all tokens. Stop at first hit — we
  // anchor the window on the most upstream occurrence to keep the
  // doc's beginning visible when scrollback isn't useful.
  let idx = -1;
  for (const t of tokens) {
    const pos = lower.indexOf(t);
    if (pos >= 0 && (idx < 0 || pos < idx)) idx = pos;
  }
  if (idx < 0) {
    // No keyword hit — keep the head of the doc. Articles usually
    // open with a TL;DR / spec, so this is a sensible default.
    return body.slice(0, windowSize) + "\n…（剩余正文已截断）";
  }
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, idx - half);
  const end = Math.min(body.length, start + windowSize);
  // If we hit the end first, slide the window backward so we still
  // get a full `windowSize` chunk (don't waste budget on a partial).
  if (end - start < windowSize) start = Math.max(0, end - windowSize);
  const head = start > 0 ? "…（前文已截断）\n" : "";
  const tail = end < body.length ? "\n…（后文已截断）" : "";
  return head + body.slice(start, end) + tail;
}
