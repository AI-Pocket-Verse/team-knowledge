// article-review 的通知:收件人=最后编辑者(最近带作者版本,回退创建者)。直接写
// Notification 行(不走 emitNotification 的 resolveRecipients —— 那是按事件类型派生收件人,
// 不适合「定向给某人」),再 kickDispatch 推飞书。dedupeKey 按内容版本去重。
import { prisma } from "../../db.js";
import { kickDispatch } from "../../utils/notify/dispatcher.js";
import { trackBestEffort } from "../../utils/guards.js";
import { REVIEW_CATEGORY_LABEL, type HashedReviewFinding } from "./findings.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

/** 最后编辑者 id:最近一条带作者的「人工编辑」ArticleVersion;无则回退创建者;再无则 null。
 *  排除 ai-fix(一键优化应用)与 restore(版本回滚)—— 否则刚点「应用」的人会被当成
 *  最后编辑者,在下一轮仍有问题时收到本非他引入的问题的提醒。 */
export async function resolveLastEditorId(articleId: string): Promise<string | null> {
  const v = await prisma.articleVersion.findFirst({
    where: { articleId, authorId: { not: null }, kind: { notIn: ["ai-fix", "restore"] } },
    orderBy: { createdAt: "desc" },
    select: { authorId: true },
  });
  if (v?.authorId) return v.authorId;
  const a = await prisma.article.findUnique({ where: { id: articleId }, select: { createdById: true } });
  return a?.createdById ?? null;
}

/** 通知摘要:「N 处问题:类别1、类别2…」(最多列 3 类)。 */
export function reviewSummary(findings: HashedReviewFinding[]): string {
  const cats = [...new Set(findings.map((f) => REVIEW_CATEGORY_LABEL[f.category]))].slice(0, 3);
  return `${findings.length} 处问题:${cats.join("、")}`;
}

export async function emitReviewNotification(input: {
  articleId: string;
  articleTitle: string;
  recipientId: string;
  findings: HashedReviewFinding[];
  reviewedHash: string;
}): Promise<void> {
  if (input.findings.length === 0) return;
  const dedupeKey = `review:${input.articleId}:${input.reviewedHash}`;
  const dup = await prisma.notification.findFirst({ where: { dedupeKey }, select: { id: true } });
  if (dup) return;

  const pref = await prisma.notificationPref.findUnique({ where: { userId: input.recipientId } });
  const feishuState = pref && !pref.feishuEnabled ? "skipped" : "pending";

  await prisma.notification.create({
    data: {
      recipientId: input.recipientId,
      actorId: null,
      type: "article_review_issue",
      articleId: input.articleId,
      payload: JSON.stringify({ actorName: `${ASSISTANT_NAME} 体检`, articleTitle: input.articleTitle, excerpt: reviewSummary(input.findings) }),
      dedupeKey,
      feishuState,
    },
  });
  if (feishuState === "pending") trackBestEffort(kickDispatch());
}

/** 修复/忽略/复检通过后:把该文章未读的 review 通知置已读(清铃铛)。 */
export async function clearReviewNotifications(articleId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { articleId, type: "article_review_issue", readAt: null },
    data: { readAt: new Date() },
  });
}
