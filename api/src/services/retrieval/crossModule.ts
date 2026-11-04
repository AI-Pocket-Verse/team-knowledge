// 专家地基:跨模块检索 —— 会议纪要(MeetingSession.summaryMarkdown)+ 群答疑(QaStatEntry.question)。
// 这些知识在系统里但不在「文档」FTS 索引里;给专家一个统一的 token 命中检索,返回带出处候选。
// 简单确定性打分(query 切 token,候选文本命中多少 token),作为次要来源足够;暂不引 FTS。
import { prisma } from "../../db.js";
import { recentStats } from "../group-qa/store.js";

export interface CrossModuleHit {
  source: "meeting" | "group-qa";
  title: string;
  snippet: string;
  ref: string; // meeting: 会议 id;group-qa: 答疑 hash
}

// 把查询切成 token(中英文标点/空白分隔,长度 ≥ 2);切不出则用整串。
export function queryTokens(query: string): string[] {
  const toks = query
    .split(/[\s,，。、;；:：?？!！「」『』（）()\[\]【】~～\-—/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (toks.length > 0) return toks;
  const whole = query.trim();
  return whole ? [whole] : [];
}

function score(text: string, tokens: string[]): number {
  return tokens.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
}

/** 跨模块检索。返回按命中分降序的候选(默认上限 4)。无 token / 无命中 → []。 */
export async function searchCrossModule(query: string, limit = 4): Promise<CrossModuleHit[]> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const scored: { s: number; hit: CrossModuleHit }[] = [];

  // 会议纪要(取近 50 场有纪要的、未删除的公开会议做 token 命中)。
  // 只取公开会议：命中结果会进任意成员的助手上下文，回答还可能发到飞书群，
  // 即使提问者是私密会议的创建者本人也不能放行。
  const meetings = await prisma.meetingSession.findMany({
    where: { deletedAt: null, visibility: "public", summaryMarkdown: { not: null } },
    select: { id: true, title: true, summaryMarkdown: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  for (const m of meetings) {
    const s = score(`${m.title}\n${m.summaryMarkdown ?? ""}`, tokens);
    if (s > 0) scored.push({ s, hit: { source: "meeting", title: m.title, snippet: (m.summaryMarkdown ?? "").slice(0, 300), ref: m.id } });
  }

  // 群答疑(近 200 条)
  const qa = await recentStats(200);
  for (const q of qa) {
    const s = score(`${q.chatName}\n${q.question}\n${q.sourceTitle}`, tokens);
    if (s > 0) scored.push({ s, hit: { source: "group-qa", title: q.chatName, snippet: q.question.slice(0, 300), ref: q.hash } });
  }

  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.hit);
}
