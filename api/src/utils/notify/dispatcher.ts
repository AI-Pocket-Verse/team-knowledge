// Feishu delivery worker. Drains pending/failed Notification rows and pushes
// each as an interactive card via the feishu-sso gateway. Guardrails: skip recipients
// without a usable open_id; per-recipient rate cap (avoid Feishu frequency
// limits on a hot doc); bounded retry with feishuTries. Runs both on a poll
// interval (startDispatcher) and on-demand right after emit (kickDispatch), so
// notifications are effectively immediate but still resilient if a send fails.
//
// v1 is an in-process poller (fine at this scale); a Redis-backed queue can
// replace kickDispatch/startDispatcher later without touching emit.
import { prisma } from "../../db.js";
import { feishuGateway } from "../feishuGateway.js";
import { buildNotificationCard, type NotifType } from "./card.js";
import { isRestoring } from "../../services/backup.js";

const MAX_TRIES = 3;
const RATE_PER_MIN = 5; // max Feishu pushes per recipient per rolling minute
const BATCH = 50;

let running = false;

// 飞书发送失败后的退避:进程内按通知 id 记下次可重试时间(重启后清零,等于立即可重试)。
// 退避 60s、120s…封顶 10 分钟,配合 MAX_TRIES 把"瞬时故障"和"持续故障"区分开。
const retryAt = new Map<string, number>();
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;
// 每轮最多扫描这么多条失败行,从中挑出已过退避期的。
const FAILED_SCAN = 500;

export function startDispatcher(intervalMs = 3000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void kickDispatch();
  }, intervalMs);
}

/** One delivery pass. Re-entrant-safe: a second concurrent call no-ops. */
export async function kickDispatch(): Promise<void> {
  if (running || isRestoring()) return; // 还原热替换库期间不碰 DB
  running = true;
  try {
    const now = Date.now();
    for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);

    // 选取时排除近一分钟已达上限的收件人,否则他们的积压行永远排在队首占满批次,
    // 饿死后面其他人的通知。
    const capped = await prisma.notification.groupBy({
      by: ["recipientId"],
      where: { feishuSentAt: { gte: new Date(now - 60_000) } },
      _count: { _all: true },
      having: { recipientId: { _count: { gte: RATE_PER_MIN } } },
    });

    const base = {
      feishuTries: { lt: MAX_TRIES },
      recipientId: { notIn: capped.map((c) => c.recipientId) },
    };
    const include = { recipient: { select: { ssoId: true, isActive: true } } } as const;
    // 只有失败过的行才会进退避表,所以 pending 行单独取,不会被退避中的行挤占批次。
    // 退避表不拼进 SQL(id 多了会超过 SQLite 的参数上限),在内存里过滤失败行。
    const pending = await prisma.notification.findMany({
      where: { ...base, feishuState: "pending" },
      orderBy: { createdAt: "asc" },
      take: BATCH,
      include,
    });
    const retryable = (await prisma.notification.findMany({
      where: { ...base, feishuState: "failed" },
      orderBy: { createdAt: "asc" },
      take: FAILED_SCAN,
      include,
    })).filter((n) => !retryAt.has(n.id)).slice(0, BATCH);
    const due = [...pending, ...retryable];

    for (const n of due) {
      const openId = n.recipient.ssoId;
      // ssoId is anchored to the Feishu open_id (ou_*). Anything else (a legacy
      // cuid not yet re-anchored) can't receive a bot DM → skip Feishu, keep
      // the in-app row.
      // 已停用成员同样跳过(终态,不再补发)。
      if (!n.recipient.isActive || !openId || !openId.startsWith("ou_")) {
        await prisma.notification.update({ where: { id: n.id }, data: { feishuState: "skipped" } });
        continue;
      }

      // 限频按「实际发送时刻」(feishuSentAt)统计。按 createdAt 数的话,积压
      // 补发时(行都创建于 1 分钟前)恒为 0,护栏恰在最需要的场景失效。
      const recentSent = await prisma.notification.count({
        where: {
          recipientId: n.recipientId,
          feishuSentAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      if (recentSent >= RATE_PER_MIN) {
        // Over the per-minute cap — DON'T drop it. Leave the row "pending" so a
        // later pass retries once capacity frees (rather than losing a real
        // notification forever). `skipped` is terminal (not re-selected), which
        // is correct for the non-ou_ case above but wrong for a transient cap.
        continue;
      }

      try {
        const p = JSON.parse(n.payload) as { actorName: string; articleTitle: string; excerpt?: string };
        const card = buildNotificationCard({
          type: n.type as NotifType,
          actorName: p.actorName,
          articleTitle: p.articleTitle,
          articleId: n.articleId ?? "",
          commentId: n.commentId ?? undefined,
          excerpt: p.excerpt,
        });
        const { messageId } = await feishuGateway.notify(openId, card);
        await prisma.notification.update({
          where: { id: n.id },
          data: { feishuState: "sent", feishuMsgId: messageId, feishuSentAt: new Date() },
        });
      } catch {
        retryAt.set(n.id, Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** n.feishuTries, BACKOFF_MAX_MS));
        await prisma.notification.update({
          where: { id: n.id },
          data: { feishuState: "failed", feishuTries: { increment: 1 } },
        });
      }
    }
  } catch (err) {
    // setInterval 的裸 void 调用没有兜底:这里不接住的话,DB 抖动(锁 / 备份
    // 还原热切换 / catch 分支里的状态回写失败)会变成 unhandled rejection 把
    // 整个进程带崩。吞掉记日志即可 —— 下个轮询周期自然重试。
    console.warn("[notify-dispatcher] dispatch pass failed:", (err as Error).message);
  } finally {
    running = false;
  }
}
