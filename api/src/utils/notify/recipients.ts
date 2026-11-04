// Resolve WHO should be notified for an engagement event, and with what
// per-recipient framing (type). Rules:
//   - article_like / article_favorite → author + collaborators (role members
//     + per-article editors).
//   - article_comment / comment_reply → above + comment-thread participants
//     (distinct comment authors) + @mentioned users.
//   - The actor is never notified about their own action.
//   - Each recipient gets exactly ONE notification, typed by the highest
//     priority relationship: @mention > reply-to-your-comment > comment > base.
import { prisma } from "../../db.js";
import type { NotifType } from "./card.js";

export interface NotifEvent {
  /** Base event. comment_reply implies a parent comment. */
  type: "article_like" | "article_favorite" | "article_comment" | "comment_reply";
  articleId: string;
  actorId: string;
  commentId?: string;
  /** Replied-to comment's author (reply events only) — gets comment_reply framing. */
  parentAuthorId?: string | null;
  /** Users @mentioned in the comment body (comment events only). */
  mentionedUserIds?: string[];
}

const isCommentEvent = (t: NotifEvent["type"]) => t === "article_comment" || t === "comment_reply";

/** Map of recipientId → the NotifType to record for that recipient.
 *  `includeSelf` (default false) keeps the actor in the set — only for the
 *  NOTIFY_INCLUDE_SELF dev/testing flag; normal behavior excludes self. */
export async function resolveRecipients(
  ev: NotifEvent,
  opts: { includeSelf?: boolean } = {},
): Promise<Map<string, NotifType>> {
  const result = new Map<string, NotifType>();
  const article = await prisma.article.findUnique({
    where: { id: ev.articleId },
    select: { createdById: true, roleId: true },
  });
  if (!article) return result;

  const mentioned = new Set(ev.mentionedUserIds ?? []);
  const candidates = new Set<string>();

  // Author + collaborators (role members + per-article editors).
  if (article.createdById) candidates.add(article.createdById);
  const [roleMembers, editors] = await Promise.all([
    prisma.userRole.findMany({ where: { roleId: article.roleId }, select: { userId: true } }),
    prisma.articleEditor.findMany({ where: { articleId: ev.articleId }, select: { userId: true } }),
  ]);
  for (const r of roleMembers) candidates.add(r.userId);
  for (const e of editors) candidates.add(e.userId);

  // Comment events also reach prior participants + @mentioned users.
  if (isCommentEvent(ev.type)) {
    const participants = await prisma.comment.findMany({
      where: { articleId: ev.articleId, authorId: { not: null } },
      select: { authorId: true },
      distinct: ["authorId"],
    });
    for (const p of participants) if (p.authorId) candidates.add(p.authorId);
    for (const id of mentioned) candidates.add(id);
  }

  if (!opts.includeSelf) candidates.delete(ev.actorId); // normally never notify the actor about their own action

  // 已停用成员(离职等)不再收通知:角色成员 / 评论参与者 / @ 的人都可能是停用账号。
  if (candidates.size > 0) {
    const active = await prisma.user.findMany({
      where: { id: { in: [...candidates] }, isActive: true },
      select: { id: true },
    });
    const activeIds = new Set(active.map((u) => u.id));
    for (const id of [...candidates]) if (!activeIds.has(id)) candidates.delete(id);
  }

  for (const userId of candidates) {
    let type: NotifType;
    if (isCommentEvent(ev.type) && mentioned.has(userId)) type = "comment_mention";
    else if (ev.type === "comment_reply" && ev.parentAuthorId && userId === ev.parentAuthorId) type = "comment_reply";
    else if (isCommentEvent(ev.type)) type = "article_comment";
    else type = ev.type; // article_like | article_favorite
    result.set(userId, type);
  }
  return result;
}
