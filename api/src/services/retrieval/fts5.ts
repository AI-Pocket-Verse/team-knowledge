import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { getAssistantExclusionSets, exclusionSqlFilter } from "../assistant-filter/exclusions.js";

export interface SearchHit {
  articleId: string;
  title: string;
  snippet: string;
  body: string;
  folderId: string;
  roleId: string;
  folderName: string;
  roleName: string;
}

export interface SearchInput {
  query: string;
  userId: string;
  isAdmin: boolean;
  limit?: number;
}

// Per-doc body cap fed to the LLM prompt. A reasonable doc (PRD,
// privacy policy, retro) lands well under this; longer docs (book-
// length specs, scraped logs) get tail-truncated. 20K chars covers
// ~99% of legitimate articles end-to-end and still leaves plenty of
// room in a 128K-token context for 5 such docs + system prompt +
// chat history. Was 1500 originally — that cap predated the trigram
// FTS rollout and was tuned for snippet-style previews, but it
// silently held AI grounding to the first ~3 paragraphs of every
// doc, which is why "I can't find anything" was the default reply
// for any question targeting content beyond the intro.
const BODY_CAP = 20_000;

// INTERIM PERF BOUND (#6). The FTS5 virtual table was removed earlier, so
// retrieval is currently a full-table leading-wildcard `LIKE %…%` over
// title + contentMarkdown. Without a cap, one query can score and ORDER BY
// the ENTIRE corpus on every chat turn — unbounded as the doc set grows.
//
// As a bounded mitigation we first collect at most CANDIDATE_CAP MATCHING
// rows (ids only, ordered by the cheap `updatedAt DESC`), then compute the
// length-weighted score + substr-capped body ONLY over that bounded set.
// SQLite stops the inner scan once CANDIDATE_CAP matches are found, so the
// worst case (a query that matches everything) no longer scans/scores the
// whole table. The cap is kept well above the output `limit` so ranking
// quality is preserved for any realistic corpus.
//
// This is an INTERIM bound, not a real index: a query whose matches all sit
// past the freshest CANDIDATE_CAP rows can still miss them. A proper FTS5
// rebuild (BM25 over an indexed virtual table) is a SEPARATE task.
const CANDIDATE_CAP = 500;

interface Row {
  articleId: string;
  title: string;
  snippet: string;
  body: string;
  folderId: string;
  roleId: string;
  folderName: string;
  roleName: string;
}

// Common Chinese function / connector / question words. We use them
// purely as DELIMITERS to slice a natural-language question into the
// content phrases the user actually cares about — we never index or
// match them on their own. List is intentionally conservative; over-
// filtering risks chopping real keywords (e.g. dropping "分析" was
// debated but kept because users almost never search FOR "分析",
// they're asking the AI to perform analysis).
const QUERY_DELIMITERS: ReadonlyArray<string> = [
  // 助词 / 介词
  "的", "地", "得", "了", "着", "过", "在", "是", "也", "都", "就", "还", "只", "又", "更", "最", "很",
  // 代词
  "我们", "你们", "他们", "我", "你", "他", "她", "它", "这", "那", "哪", "这个", "那个", "这些", "那些",
  // 连词
  "结合", "并且", "和", "与", "或", "但", "及", "以及", "或者", "但是", "然而", "不过", "因为", "所以", "如果", "那么", "然后", "另外",
  // 助动词
  "可以", "可能", "应该", "需要", "会", "要", "能",
  // 副词 / 疑问
  "如何", "怎么", "什么", "为什么", "是否", "有没有", "能否", "请", "帮", "把", "给", "让", "吗", "呢", "啊", "吧", "呀",
  // 数量
  "一下", "一些", "一点", "一会儿", "一会",
  // 时间
  "现在", "当前", "目前", "以前", "以后", "之前", "之后", "近期", "最近",
  // 动作动词（用户问句里几乎只作"动作描述"，不是检索关键词）
  "分析", "看看", "看下", "查看", "了解", "知道", "告诉", "说说", "谈谈", "聊聊", "总结", "归纳", "梳理", "整理", "对比", "比较", "评估", "审视",
  // 高频抽象名词 / 泛指词(低信号:作切分用,避免「新版本隐私协议」黏成一坨把「隐私」埋掉)
  "问题", "内容", "信息", "情况", "方面", "方向", "角度", "版本", "新版",
  // 礼貌
  "谢谢", "劳烦", "麻烦",
];

const SENTINEL = "";
const PUNCT_OR_SPACE = /[\s　\p{P}]+/gu;

/**
 * 「版本号 / 版本计量」这类低信号碎片:V1、v2.0、1.2.1、V1.2.1到V2.0.0、2.0~3.0、
 * 6个版本、版本。它们几乎出现在每篇带版本号的文档里(V1.x-test-cases…),一旦作为 LIKE
 * 词就把这些文档统统顶到检索前列、淹没真正的话题词(如「隐私协议」),让 LLM 拿到不相关
 * 文档硬答(反例:问「跨版本隐私协议要补充啥」却引到《V1.3.5-test-cases》)。仅当句中还有
 * 别的内容词时才剔除;若整句只有版本号(用户确在问某版本),则保留。
 */
function isVersionNoise(t: string): boolean {
  if (/^[vV]?\d+(?:[.\-_~到至]+[vV]?\d+)*$/.test(t)) return true; // V1 / 2.0 / 1到V2 / V1.2.1到V2.0.0
  if (/^\d*个?版本$/.test(t)) return true; // 版本 / 6版本 / 6个版本
  return false;
}

/**
 * Slice a natural-language query into the content phrases that should
 * be OR-matched against the corpus.
 *
 * Rationale — the previous code wrapped the whole `query` as a single
 * FTS5 quoted phrase (`"...full sentence..."`). With the trigram
 * tokenizer that becomes a strict literal-substring match for the
 * entire sentence, so any question longer than a few characters
 * matched nothing (the user only ever saw "未在已发布文档中找到").
 *
 * This tokenizer is intentionally heuristic-only — no NLP, no morph
 * analysis. We strip punctuation, then use `QUERY_DELIMITERS` to chop
 * the sentence at function words, leaving the content phrases. Each
 * remaining phrase ≥ 2 chars becomes one OR'd term; BM25 ranks docs
 * by how many of those phrases they contain.
 */
export function tokenizeQuery(q: string): string[] {
  if (!q) return [];
  let s = q.replace(PUNCT_OR_SPACE, SENTINEL);
  for (const sw of QUERY_DELIMITERS) {
    if (s.includes(sw)) s = s.split(sw).join(SENTINEL);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of s.split(SENTINEL)) {
    const t = seg.trim();
    if (t.length < 2) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  // Longer phrases first — they're more specific, so they should
  // dominate BM25 when we hit the LIMIT below.
  out.sort((a, b) => b.length - a.length);
  // 剔除版本号噪声 —— 但只在还剩别的内容词时;否则(整句只有版本号)原样保留。
  const content = out.filter((t) => !isVersionNoise(t));
  const kept = content.length > 0 ? content : out;
  // Cap so a paragraph-length question doesn't generate an FTS5 query
  // string that the planner gives up on.
  return kept.slice(0, 8);
}

export async function search({ query, limit = 5 }: SearchInput): Promise<SearchHit[]> {
  if (!query || !query.trim()) return [];

  // No visibility gate: all non-deleted docs are searchable. (userId/isAdmin
  // are still on SearchInput for call-site compat but no longer gate results.)

  // Decompose the user's question into content phrases.
  const phrases = tokenizeQuery(query);
  // Expand longer phrases with their leading + trailing 2-char bigrams
  // so a query like "隐私协议" still pulls a doc titled "隐私政策" — the
  // shared "隐私" bigram bridges what trigram FTS5 cannot (mismatching
  // 4-char strings share no common 3-gram). Inner straddling bigrams
  // (e.g. "私协") are intentionally NOT emitted — see expandTokens for
  // the noise rationale (#21). The original long phrase stays in the
  // token list with higher length-based weight, so docs that DO contain
  // the exact phrase still rank above the 2-char-fragment matches.
  const tokens = expandTokens(phrases);
  if (tokens.length === 0) return [];

  //助手内容过滤:被排除的角色 / 文件夹(含子文件夹)/ 文档不进入检索
  // (问答 / 会议讨论 / 群聊答疑 都走这条中央检索)。空清单时退化为 Prisma.empty
  // → 行为与过滤前完全一致(零回归)。
  //
  // FAIL-OPEN on a lookup error, matching this function's existing defensive
  // posture (the $queryRaw below also catches + returns [] rather than throw).
  // The exclusion lookup does 1–2 DB queries; a transient failure must NOT
  // propagate out of search(), or it would hard-error the 问答 turn
  // (runChatTurn surfaces a thrown prepare step as an error event) where the
  // old `Prisma.empty` could never throw. Exclusion is anti-pollution, not a
  // anti-pollution filter, not a hard ACL, so degrading to
  // "unfiltered for this one turn" is the correct, least-surprising fallback.
  let exclusionFilter: Prisma.Sql = Prisma.empty;
  try {
    exclusionFilter = exclusionSqlFilter(await getAssistantExclusionSets());
  } catch (err) {
    console.error("[search] exclusion lookup failed; proceeding unfiltered:", (err as Error).message);
  }

  // Build the WHERE (OR'd LIKE patterns) + the ORDER BY score
  // expression (length-weighted, title >> body). LIKE patterns are
  // parameter-bound so user input can never escape into SQL.
  const wherePieces: Prisma.Sql[] = [];
  const scoreTerms: Prisma.Sql[] = [];
  for (const t of tokens) {
    const pat = `%${t}%`;
    wherePieces.push(Prisma.sql`a.title LIKE ${pat}`);
    wherePieces.push(Prisma.sql`a.contentMarkdown LIKE ${pat}`);
    const titleWeight = Prisma.raw(String(50 * t.length));
    const bodyWeight = Prisma.raw(String(5 * t.length));
    scoreTerms.push(Prisma.sql`(CASE WHEN a.title LIKE ${pat} THEN ${titleWeight} ELSE 0 END) + (CASE WHEN a.contentMarkdown LIKE ${pat} THEN ${bodyWeight} ELSE 0 END)`);
  }
  const whereCombined = Prisma.join(wherePieces, " OR ");
  const scoreSum = Prisma.join(scoreTerms, " + ");

  // Note we no longer touch `article_fts` — see comment at top of
  // file. The virtual table + sync triggers are left in the schema
  // intentionally so future re-introduction (BM25 ranking, semantic
  // search side-by-side) doesn't require a re-migration.
  //
  // Two-stage to keep the worst case bounded (see CANDIDATE_CAP):
  //   1. inner `cand` — collect ids of at most CANDIDATE_CAP MATCHING rows,
  //      ordered by the cheap `updatedAt DESC`. Selects only the id (and the
  //      LIKE predicate over title/body) — never materializes the body — so
  //      a huge corpus can't make this scan/score everything unboundedly.
  //   2. outer — join only those candidate ids back to Article, compute the
  //      length-weighted score + substr-capped body, ORDER BY score, take the
  //      final `limit`. LEFT JOIN Folder so role-direct articles (folderId
  //      IS NULL) still surface (folderName falls back to the role name).
  //      Role joins on the article's own roleId column (denormalized).
  const sql = Prisma.sql`
    WITH cand AS (
      SELECT a.id AS id
        FROM Article a
       WHERE a.deletedAt IS NULL
         AND (${whereCombined})${exclusionFilter}
       ORDER BY a.updatedAt DESC
       LIMIT ${Prisma.raw(String(CANDIDATE_CAP))}
    )
    SELECT a.id AS articleId, a.title AS title,
           '' AS snippet,
           substr(a.contentMarkdown, 1, ${Prisma.raw(String(BODY_CAP))}) AS body,
           COALESCE(a.folderId, '') AS folderId, a.roleId AS roleId,
           COALESCE(m.name, r.name) AS folderName, r.name AS roleName
      FROM cand
      JOIN Article a ON a.id = cand.id
      LEFT JOIN Folder m ON m.id = a.folderId
      JOIN Role r ON r.id = a.roleId
     ORDER BY (${scoreSum}) DESC, a.updatedAt DESC
     LIMIT ${limit}
  `;

  try {
    return await prisma.$queryRaw<Row[]>(sql);
  } catch (err) {
    // Mirror the original failure mode: log + return [] so a malformed
    // query (or a transient SQLite hiccup) never crashes the chat
    // turn. The chat route's request log will pick this up.
    console.error("[search] query failed:", (err as Error).message);
    return [];
  }
}

/**
 * For every input phrase, emit the phrase itself AND — if the phrase
 * is ≥ 4 chars — only its LEADING and TRAILING 2-char bigrams. Used to
 * bridge the "synonym mismatch" case where the user's chosen surface
 * vocabulary differs from the document's:
 *
 *   query="隐私协议" → ["隐私协议","隐私","协议"]
 *
 * The shared 2-char bigram "隐私" lets a LIKE-scan pull a document
 * titled "Assistant_隐私政策" even though no 3-char trigram is shared.
 *
 * (#21) We DELIBERATELY drop the inner sliding-window bigrams that
 * straddle word boundaries (e.g. "私协" from "隐私协议"). For typical
 * 隐私|协议-style compounds those inner fragments are low-signal:
 * "私协" is not a real word, so OR-matching it with %…% against
 * contentMarkdown mostly drags in topically-unrelated published docs
 * that happen to contain those two adjacent chars, diluting the
 * grounding corpus. The prefix and suffix bigrams, by contrast, almost
 * always align with a real leading/trailing morpheme of the phrase, so
 * they preserve the legitimate synonym-bridging recall this expansion
 * exists for. Length-weighted scoring in `search` still ranks docs
 * containing the full phrase above any bigram-only match.
 */
// 仅对【含 CJK 的】长词做首尾 2-char 切桥(中文同义词/构词桥接,如 隐私协议↔隐私政策)。
// 纯拉丁词(如 "hello")绝不切:其 2-char 片段("he"/"lo")是英文里到处都有的子串,
// LIKE %he%/%lo% 会命中几乎任何含英文正文的文档,把无关文档顶进出处(反例:问 "hello"
// 却引到《APP 接入三方 SDK 调研》《V1.3.0》)。拉丁词只按整词 LIKE 匹配,无则不召回。
const HAS_CJK = /[㐀-鿿豈-﫿]/;
function expandTokens(phrases: string[]): string[] {
  const seen = new Set<string>();
  for (const p of phrases) {
    seen.add(p);
    if (p.length >= 4 && HAS_CJK.test(p)) {
      seen.add(p.slice(0, 2));        // leading bigram
      seen.add(p.slice(p.length - 2)); // trailing bigram
    }
  }
  return Array.from(seen);
}
