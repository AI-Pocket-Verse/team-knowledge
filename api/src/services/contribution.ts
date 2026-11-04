// 贡献度计分:加权权重表 + 「被认可」加分。周报累加(weekly-report.ts)与
// 数据看板排行(routes/admin-analytics.ts)共用同一口径,避免两处漂移。
//
// - CONTRIBUTION_WEIGHTS:每类行为的分值。未列出的行为默认 1(见 eventWeight)。
// - receivedRecognition:窗口内「内容所有者收到的认可」加分(点赞/收藏/评论赞),
//   排除自赞、排除已删内容,按 cap 封顶。
import { prisma } from "../db.js";

// 贡献度权重(加权计分)。可在此调整。未列出的动作默认 1 分。
export const CONTRIBUTION_WEIGHTS: Record<string, number> = {
  doc_create: 4,
  doc_fix: 3,
  doc_edit: 3,
  meeting: 3,
  chat: 3,
  comment: 2,
  doc_restore: 2,
  automation_create: 2,
  meeting_comment: 1,
  folder_create: 1,
  editor_grant: 0.5,
  like: 1,
  bookmark: 1,
  upload: 1,
  doc_archive: 1,
  doc_unarchive: 1,
  comment_like: 0.5,
  // 浏览:分值最低。注意 view 有两条不同的计分路径 ——
  //   - 数据看板(admin-analytics 走 loadActivityEvents):事件流本就不含 view,此权重用不到;
  //   - 周报(weekly-report 自行从 ArticleView 构造 type:"view" 事件):按此权重计分。
  // 故此权重必须保留:删掉会让周报的浏览计分静默回落默认 1(5 倍膨胀并重排贡献榜)。
  view: 0.2,
};

// 未列出的行为默认 1 分。
export function eventWeight(type: string): number {
  return CONTRIBUTION_WEIGHTS[type] ?? 1;
}

// 每收到一次认可(被赞/被收藏/评论被赞)加的分,以及单窗口封顶。
export const RECEIVED_UNIT = 0.5;
export const RECEIVED_WEEKLY_CAP = 10;

// 统计窗口内「每个内容所有者收到的认可」并 ×RECEIVED_UNIT、按 cap 封顶
// (min(cap, unit*count))。认可来源三类,均排除自赞(操作者 != 内容所有者)、
// 排除已删内容:
//   - Like:like.article.createdById 为所有者,article 未删
//   - Bookmark:同上
//   - CommentLike:commentLike.comment.authorId 为所有者,comment 及其 article 未删
// 返回 uid → 加分。窗口是左闭右开 [windowStart, windowEnd):必须带上界,否则重算「上一周」
// 报表时,本周及以后的点赞会漏算进上周,使历史周报不可复现、分数持续虚高。
export async function receivedRecognition(windowStart: Date, windowEnd: Date, cap: number): Promise<Map<string, number>> {
  const since = { createdAt: { gte: windowStart, lt: windowEnd } };
  const [likes, bookmarks, commentLikes] = await Promise.all([
    prisma.like.findMany({
      where: { ...since, article: { deletedAt: null } },
      select: { userId: true, article: { select: { createdById: true } } },
    }),
    prisma.bookmark.findMany({
      where: { ...since, article: { deletedAt: null } },
      select: { userId: true, article: { select: { createdById: true } } },
    }),
    prisma.commentLike.findMany({
      where: { ...since, comment: { article: { deletedAt: null } } },
      select: { userId: true, comment: { select: { authorId: true } } },
    }),
  ]);

  // owner → 收到的认可次数(排除自赞、排除所有者已被硬删的孤儿行)。
  const counts = new Map<string, number>();
  const bump = (owner: string | null | undefined, actor: string) => {
    if (!owner || owner === actor) return; // 排除自赞 / 无所有者
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  };
  for (const l of likes) bump(l.article?.createdById, l.userId);
  for (const b of bookmarks) bump(b.article?.createdById, b.userId);
  for (const c of commentLikes) bump(c.comment?.authorId, c.userId);

  const out = new Map<string, number>();
  for (const [owner, count] of counts) {
    out.set(owner, Math.min(cap, RECEIVED_UNIT * count));
  }
  return out;
}
