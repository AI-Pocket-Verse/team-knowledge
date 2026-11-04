import { createHash } from "node:crypto";

// Budget for how much article text we feed the model in one synthesis call.
// Beyond this, remaining docs are reduced to title + a short head (and counted
// as `truncated`) so a huge role can't blow the prompt / cost. The doc INDEX
// still lists every doc regardless, so nothing silently disappears.
export const MAX_INPUT_CHARS = 120_000;
export const TRUNC_HEAD_CHARS = 500;
// Hard cap on how many docs the index lists, so a role with thousands of docs
// can't produce a multi-megabyte index. Bodies are bounded by MAX_INPUT_CHARS.
export const MAX_INDEX_DOCS = 300;

export interface SourceArticle {
  id: string;
  title: string;
  updatedAt: Date;
}

/**
 * Stable signature of everything that defines a role's skill.md. Used to detect
 * staleness and to skip a no-op regeneration. Order-independent across articles
 * (sorted), but sensitive to role name/description and each doc's title +
 * updatedAt — i.e. any published-content change flips the hash.
 *
 * NOTE: body content is NOT hashed directly — we rely on `Article.updatedAt`
 * bumping on every body edit (every body-writing route — create / PATCH / restore /
 * import / import-feishu / review-apply / bulk — also calls markRoleSkillStale). If a future
 * RAW SQL body write is ever added (like the edit-lock columns), it MUST either
 * bump updatedAt + call markRoleSkillStale, or this hash must include the body.
 */
export function computeSourceHash(input: {
  name: string;
  description: string | null;
  articles: SourceArticle[];
}): string {
  const docs = input.articles
    .map((a) => `${a.id}|${a.updatedAt.getTime()}|${a.title}`)
    .sort();
  const h = createHash("sha256");
  h.update(`role:${input.name}\ndesc:${input.description ?? ""}\n--docs--\n`);
  h.update(docs.join("\n"));
  return h.digest("hex");
}

export interface PackArticle {
  title: string;
  contentMarkdown: string;
}

export interface PackResult {
  body: string;
  docCount: number;
  truncated: number;
}

/**
 * Pack articles into one budgeted string for the synthesis prompt. Each doc is
 * included in full while the running total stays within `maxChars`; once a doc
 * would overflow, it's reduced to its title + first TRUNC_HEAD_CHARS chars and
 * counted in `truncated`. Callers pass articles in priority order (e.g. most
 * recently updated first) so the freshest docs keep their full text.
 */
export function packArticles(articles: PackArticle[], maxChars: number = MAX_INPUT_CHARS): PackResult {
  const parts: string[] = [];
  let used = 0;
  let truncated = 0;
  for (const a of articles) {
    const full = `## ${a.title}\n\n${a.contentMarkdown}`;
    if (used + full.length <= maxChars) {
      parts.push(full);
      used += full.length;
    } else if (used < maxChars) {
      // Near the boundary: include a reduced head, which pushes us to/over budget.
      const head = a.contentMarkdown.slice(0, TRUNC_HEAD_CHARS);
      const ellipsis = a.contentMarkdown.length > TRUNC_HEAD_CHARS ? "…（正文已截断）" : "";
      const reduced = `## ${a.title}\n\n${head}${ellipsis}`;
      parts.push(reduced);
      used += reduced.length;
      truncated += 1;
    } else {
      // Budget fully spent — omit the body entirely (the doc is still listed in
      // the index). This hard-bounds total body size for very large roles.
      truncated += 1;
    }
  }
  return { body: parts.join("\n\n"), docCount: articles.length, truncated };
}

/**
 * Split articles into batches, each whose combined `## title\n\nbody` length stays
 * within `maxChars`, so a too-large knowledge base can be audited batch-by-batch
 * (every doc read in full within its batch) instead of truncating the tail. A
 * single doc larger than `maxChars` gets its own batch alone (and is head-truncated
 * later by `packArticles`). Greedy over the given order (callers pass most-recent
 * first, but order doesn't affect completeness here).
 */
export function batchArticles(articles: PackArticle[], maxChars: number = MAX_INPUT_CHARS): PackArticle[][] {
  const batches: PackArticle[][] = [];
  let cur: PackArticle[] = [];
  let used = 0;
  for (const a of articles) {
    const len = `## ${a.title}\n\n${a.contentMarkdown}`.length;
    if (cur.length > 0 && used + len > maxChars) {
      batches.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(a);
    used += len;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/**
 * Markdown bullet list of all published doc titles. Covers EVERY doc even when
 * its body was truncated for the budget, so the skill's index stays complete.
 */
export function buildDocIndex(articles: { title: string }[]): string {
  if (articles.length === 0) return "（暂无已发布文档）";
  const shown = articles.slice(0, MAX_INDEX_DOCS).map((a) => `- ${a.title}`).join("\n");
  const extra = articles.length - MAX_INDEX_DOCS;
  return extra > 0 ? `${shown}\n- …（另有 ${extra} 篇已发布文档）` : shown;
}
