/**
 * Parse a markdown body and return the set of article ids it links to internally.
 * Excludes a self-reference id when provided. Deduplicates results.
 */
export function extractInternalReferences(markdown: string, selfId?: string): Set<string> {
  // Match the trailing article id in every doc-link form the editor has
  // emitted over time:
  //   - current  `/d/<id>`
  //   - historic `/a/<id>` (standalone)
  //   - legacy   `/r/<role>/m/<folder>/a/<id>`
  // The legacy form ends in `/a/<id>`, so the `\/[da]\/` segment alone
  // captures all three. Requiring the literal `/d/` or `/a/` (slash on BOTH
  // sides) is its own boundary — a glued `.../xa/<id>` substring has no
  // literal `/a/` (the `a` is preceded by `x`, not `/`) so it can't match.
  // The id charset `[A-Za-z0-9_-]+` stops the capture at the first
  // non-id char (e.g. the closing `)` of a markdown link).
  const pattern = /\/[da]\/([A-Za-z0-9_-]+)/g;
  const result = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const id = match[1]!;
    if (selfId && id === selfId) continue;
    result.add(id);
  }
  return result;
}
