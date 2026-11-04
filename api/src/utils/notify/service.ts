// Notification emit: resolve recipients → write per-recipient Notification rows
// (the in-app feed + the Feishu outbox) → trigger a dispatch pass. Guardrails:
// self-action already excluded by the resolver; short-window dedupe stops
// connect/disconnect spam (like→unlike→like); a muted type is suppressed
// entirely (no in-app row, no Feishu), while feishuEnabled=false keeps the
// in-app row and only skips the Feishu push. Fire-and-forget from the
// request path — never blocks the like/comment/favorite response.
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { resolveRecipients, type NotifEvent } from "./recipients.js";
import { kickDispatch } from "./dispatcher.js";
import { mentionsToPlain } from "./mentions.js";
import { trackBestEffort } from "../guards.js";
import type { NotifType } from "./card.js";

const DEDUPE_WINDOW_MS = 60_000;

function isMuted(
  pref: { muteLikes: boolean; muteFavorites: boolean; muteComments: boolean },
  type: NotifType,
): boolean {
  if (type === "article_like") return pref.muteLikes;
  if (type === "article_favorite") return pref.muteFavorites;
  return pref.muteComments; // article_comment | comment_reply | comment_mention
}

/** Plain, length-capped excerpt of a comment body for the feed / card. */
export function excerptOf(body: string): string {
  return mentionsToPlain(body) // user mentions → @name
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export async function emitNotification(ev: NotifEvent): Promise<void> {
  const recipients = await resolveRecipients(ev, { includeSelf: env.NOTIFY_INCLUDE_SELF });
  if (recipients.size === 0) return;

  // Render snapshot data loaded once (not per recipient).
  const [actor, article, comment] = await Promise.all([
    prisma.user.findUnique({ where: { id: ev.actorId }, select: { displayName: true } }),
    prisma.article.findUnique({ where: { id: ev.articleId }, select: { title: true } }),
    ev.commentId
      ? prisma.comment.findUnique({ where: { id: ev.commentId }, select: { body: true } })
      : Promise.resolve(null),
  ]);
  const actorName = actor?.displayName ?? "有人";
  const articleTitle = article?.title ?? "文档";
  const excerpt = comment?.body ? excerptOf(comment.body) : undefined;

  const ids = [...recipients.keys()];
  const prefs = await prisma.notificationPref.findMany({ where: { userId: { in: ids } } });
  const prefBy = new Map(prefs.map((p) => [p.userId, p]));
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);

  let wroteSendable = false;
  for (const [recipientId, type] of recipients) {
    // Comment-family events are DISTINCT per comment — key on commentId so two
    // different comments by the same actor within the window aren't collapsed
    // (which would also leave the surviving row's deep link pointing at the
    // wrong comment). Likes/favorites stay article+actor-scoped so a rapid
    // unlike→like still dedupes.
    const isComment = type === "article_comment" || type === "comment_reply" || type === "comment_mention";
    const dedupeKey =
      isComment && ev.commentId
        ? `${recipientId}:${type}:${ev.commentId}:${ev.actorId}`
        : `${recipientId}:${type}:${ev.articleId}:${ev.actorId}`;
    const dup = await prisma.notification.findFirst({
      where: { dedupeKey, createdAt: { gte: since } },
      select: { id: true },
    });
    if (dup) continue;

    const pref = prefBy.get(recipientId);
    // A muted type is suppressed entirely (no in-app, no Feishu). feishuEnabled
    // off keeps the in-app row but skips the Feishu push.
    if (pref && isMuted(pref, type)) continue;
    const feishuState = pref && !pref.feishuEnabled ? "skipped" : "pending";
    if (feishuState === "pending") wroteSendable = true;

    await prisma.notification.create({
      data: {
        recipientId,
        actorId: ev.actorId,
        type,
        articleId: ev.articleId,
        commentId: ev.commentId ?? null,
        payload: JSON.stringify({ actorName, articleTitle, ...(excerpt ? { excerpt } : {}) }),
        dedupeKey,
        feishuState,
      },
    });
  }

  // Immediate (per-event) Feishu push — fire-and-forget so emit never blocks.
  // Tracked so the test harness can drain it (flushBestEffortWrites) instead of
  // it racing the next test's resetDb; in prod the interval dispatcher is the
  // safety net for retries.
  if (wroteSendable) trackBestEffort(kickDispatch());
}
