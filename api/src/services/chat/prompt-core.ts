// 共享"问答核心":从 runChatTurn 提纯的检索 + @引用合并 + 建 prompt + 出处映射。
// runChatTurn(首页助手)与 orchestrate 无专家路径都复用,保证两处一致(DRY)。
import { search, type SearchHit } from "../retrieval/fts5.js";
import { buildChatPrompt } from "../prompt/build.js";
import { maybeRefreshSummary } from "./summarize.js";
import { prisma } from "../../db.js";
import type { ExpertCitation } from "../experts/expert.js";
import type { ChatHistoryMessage } from "../llm/types.js";

// 与 runChatTurn.resolveMentions 的返回结构一致(结构化兼容,无需互相 import)。
export interface ResolvedMentions {
  hits: SearchHit[];
  snapshot: { type: "doc" | "folder" | "role" | "skill"; id: string; label: string }[];
  skillBlocks: { label: string; content: string }[];
}

export interface PrepareInput {
  userId: string;
  isAdmin: boolean;
  chatPreference?: string;
  question: string;                  // 已做"只发图兜底"的 promptText
  resolvedMentions: ResolvedMentions;
  history: ChatHistoryMessage[];
  summary?: string;
  activeArticle?: SearchHit | null;  // articleId 置顶用,由调用方 loadActiveArticle 预载
  conversationId?: string;           // 提供则超阈值时可刷新摘要
  usageMarker?: boolean;             // 让模型用 [[USED: ...]] 声明实际引用,调用方据此精确列出处
}

export interface PreparedPrompt {
  systemPrompt: string;
  history: ChatHistoryMessage[];
  userMessage: string;
  citations: ExpertCitation[];       // includedHits → 底部芯片(source:doc),orchestrate 用
  includedHits: SearchHit[];         // 原始命中(runChatTurn 用来建 cited refs)
  citedArticleIds: string[];         // runChatTurn 持久化到 assistant 消息
  hadExplicitRefs: boolean;          // 是否有显式 @引用/文档内问答(有则出处恒为这些,不受 [[USED]] 影响)
}

const PROMPT_PRESSURE_THRESHOLD = 70_000;

// FTS + activeArticle 置顶 + @引用命中合并 → buildChatPrompt → includedHits 映射成 doc 出处。
// 检索/摘要顺序与 runChatTurn 一致;摘要压力刷新失败不阻塞。
export async function prepareGeneralPrompt(input: PrepareInput): Promise<PreparedPrompt> {
  const historyCap = input.summary ? 4 : 8;
  const ftsHits = await search({ query: input.question, userId: input.userId, isAdmin: input.isAdmin, limit: 5 });

  let retrieved = ftsHits;
  if (input.activeArticle) {
    const active = input.activeArticle;
    retrieved = [active, ...retrieved.filter((h) => h.articleId !== active.articleId)];
  }
  if (input.resolvedMentions.hits.length > 0) {
    const seen = new Set(retrieved.map((h) => h.articleId));
    const fresh = input.resolvedMentions.hits.filter((h) => {
      if (seen.has(h.articleId)) return false;
      seen.add(h.articleId);
      return true;
    });
    const head = input.activeArticle ? retrieved.slice(0, 1) : [];
    const tail = input.activeArticle ? retrieved.slice(1) : retrieved;
    retrieved = [...head, ...fresh, ...tail];
  }

  const buildOnce = (history: ChatHistoryMessage[], summary: string | undefined, cap: number) =>
    buildChatPrompt({
      retrieved, history, userMessage: input.question,
      mentions: input.resolvedMentions.snapshot, skills: input.resolvedMentions.skillBlocks,
      summary, historyCap: cap, userPreference: input.chatPreference,
      usageMarker: input.usageMarker,
    });

  let built = buildOnce(input.history, input.summary, historyCap);

  // 主动刷新:语料过大且尚无摘要时,先生成滚动摘要再以更短历史重建,压住 token。
  if (built.systemPrompt.length > PROMPT_PRESSURE_THRESHOLD && !input.summary && input.conversationId) {
    try {
      await maybeRefreshSummary(input.conversationId);
      const refreshed = await prisma.conversation.findUnique({ where: { id: input.conversationId } });
      if (refreshed?.summary) built = buildOnce(input.history.slice(-4), refreshed.summary, 4);
    } catch { /* 摘要刷新失败不阻塞本轮 */ }
  }

  // 出处:用户【显式 @引用 / 文档内问答】了文档时,只把这些显式文档列为出处——
  // 否则 FTS 会因问题里的关键词(尤其 @标题文字,如「APP接入三方SDK调研」)顺带召回
  // 一堆仅靠关键词重叠命中的无关文档,把它们也当「出处」展示就会误导用户。
  // 没有任何显式引用时(自由提问),才退回用全部检索命中作出处(正常召回)。
  const explicit: SearchHit[] = [];
  const seenCite = new Set<string>();
  const pushExplicit = (h: SearchHit | null | undefined) => {
    if (h && !seenCite.has(h.articleId)) { seenCite.add(h.articleId); explicit.push(h); }
  };
  pushExplicit(input.activeArticle);
  for (const h of input.resolvedMentions.hits) pushExplicit(h);
  const citedHits = explicit.length > 0 ? explicit : built.includedHits;
  const citations: ExpertCitation[] = citedHits.map((h) => ({ source: "doc", title: h.title, ref: h.articleId }));
  return {
    systemPrompt: built.systemPrompt, history: built.history, userMessage: built.userMessage,
    citations, includedHits: built.includedHits,
    // 持久化用的引用 ids 也随出处口径:有显式 @引用就只记这些(刷新后重建芯片不带 FTS 噪声)。
    citedArticleIds: explicit.length > 0 ? explicit.map((h) => h.articleId) : built.citedArticleIds,
    hadExplicitRefs: explicit.length > 0,
  };
}
