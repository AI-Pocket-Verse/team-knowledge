// Analytics — chart data for the 数据看板 (trends / composition / rankings).
// Read-only, whole-knowledge-base AGGREGATE scope, so it's served to every
// authenticated user (no per-individual breakdown here). Separate from
// /api/admin/dashboard (overview + per-user table) to keep each payload bounded.
import type { FastifyInstance } from "fastify";
import type { AdminActivityType, AdminAnalyticsResponse } from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { beijingDayKey, startOfBeijingDayMinus } from "../utils/day.js";
import { loadActivityEvents } from "../services/activity.js";
import { eventWeight, receivedRecognition, RECEIVED_WEEKLY_CAP } from "../services/contribution.js";
import { bucketTrends, bucketUploadTypes, scoreHotDocs } from "../services/analytics.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;
const TOP_N = 8;

export async function adminAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { days?: string } }>("/api/admin/analytics", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = Number(req.query.days);
    const days = Number.isFinite(parsed) ? Math.min(MAX_DAYS, Math.max(1, Math.trunc(parsed))) : DEFAULT_DAYS;

    const now = new Date();
    const windowStart = startOfBeijingDayMinus(now, days - 1);
    const dayKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) dayKeys.push(beijingDayKey(startOfBeijingDayMinus(now, i)));

    const [
      events,
      activeDayRows,
      roleGroups,
      likeCount,
      commentCount,
      bookmarkCount,
      uploadGroups,
      hotViewerGroups,
      hotLikeGroups,
      hotCommentGroups,
      hotBookmarkGroups,
      skillGroups,
      roles,
    ] = await Promise.all([
      loadActivityEvents(windowStart),
      prisma.userActiveDay.groupBy({ by: ["day"], where: { day: { in: dayKeys } }, _count: true }),
      // Live docs only (deletedAt: null), consistent with the dashboard overview.
      prisma.article.groupBy({ by: ["roleId"], where: { deletedAt: null }, _count: true }),
      prisma.like.count({ where: { article: { deletedAt: null } } }),
      prisma.comment.count({ where: { article: { deletedAt: null } } }),
      prisma.bookmark.count({ where: { article: { deletedAt: null } } }),
      prisma.upload.groupBy({ by: ["mimeType"], _count: true }),
      // 热门文档:窗口内四个信号,按文章聚合(均排除已删文档)。
      // 浏览按 lastViewedAt 落在窗口内 → 每行是一名独立读者(PK=[articleId,userId]),
      // 故 _count 即窗口内独立浏览人数;互动按 createdAt 落在窗口内计数。
      prisma.articleView.groupBy({ by: ["articleId"], where: { lastViewedAt: { gte: windowStart }, article: { deletedAt: null } }, _count: true }),
      prisma.like.groupBy({ by: ["articleId"], where: { createdAt: { gte: windowStart }, article: { deletedAt: null } }, _count: true }),
      prisma.comment.groupBy({ by: ["articleId"], where: { createdAt: { gte: windowStart }, article: { deletedAt: null } }, _count: true }),
      prisma.bookmark.groupBy({ by: ["articleId"], where: { createdAt: { gte: windowStart }, article: { deletedAt: null } }, _count: true }),
      prisma.roleSkill.groupBy({ by: ["status"], _count: true }),
      prisma.role.findMany({ select: { id: true, name: true } }),
    ]);

    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    // ── trends ──
    const content = bucketTrends(events, dayKeys);
    const activeByDay = new Map(activeDayRows.map((r) => [r.day, r._count]));
    const activeUsers = dayKeys.map((k) => activeByDay.get(k) ?? 0);

    // ── composition.byRole + rankings.docsByRole (one groupBy) ──
    const byRole = roleGroups
      .map((g) => ({ roleId: g.roleId, roleName: roleName.get(g.roleId) ?? "（已删除角色）", count: g._count }))
      .sort((a, b) => b.count - a.count);
    const docsByRole = byRole.slice(0, TOP_N);

    const byInteraction = [
      { key: "like" as const, count: likeCount },
      { key: "comment" as const, count: commentCount },
      { key: "bookmark" as const, count: bookmarkCount },
    ];
    const byUpload = bucketUploadTypes(uploadGroups.map((g) => ({ mimeType: g.mimeType, count: g._count })));

    // ── rankings.hotDocs — 窗口内综合热度(浏览人数 + 点赞×2 + 评论×3 + 收藏×2)──
    const hotScores = scoreHotDocs({
      viewers: hotViewerGroups.map((g) => ({ articleId: g.articleId, count: g._count })),
      likes: hotLikeGroups.map((g) => ({ articleId: g.articleId, count: g._count })),
      comments: hotCommentGroups.map((g) => ({ articleId: g.articleId, count: g._count })),
      bookmarks: hotBookmarkGroups.map((g) => ({ articleId: g.articleId, count: g._count })),
    });
    // 取分数最高的一批候选,解析标题(再次滤掉已删/缺失),凑满 top-N。
    const hotIds = hotScores.slice(0, TOP_N * 3).map((h) => h.articleId);
    const liveArticles = hotIds.length
      ? await prisma.article.findMany({ where: { id: { in: hotIds }, deletedAt: null }, select: { id: true, title: true } })
      : [];
    const titleById = new Map(liveArticles.map((a) => [a.id, a.title]));
    const hotDocs = hotScores
      .filter((h) => titleById.has(h.articleId))
      .slice(0, TOP_N)
      .map((h) => ({
        articleId: h.articleId, title: titleById.get(h.articleId)!,
        score: h.score, viewers: h.viewers, likes: h.likes, comments: h.comments, bookmarks: h.bookmarks,
      }));

    // ── rankings.topContributors — 加权活跃分(含近因衰减 + 被认可加分)per actor ──
    // 每类行为按 eventWeight 加权,并乘近因衰减因子(越近权重越高),再叠加窗口内
    // 「被认可」加分(cap 按天数比例放宽:RECEIVED_WEEKLY_CAP * days/7)。ops 为原始
    // 操作数,breakdown 为各类操作次数(明细 tooltip 用)。
    //
    // 近因衰减仅用于看板「活跃贡献者」(强调近期活跃);周报是固定周口径,不做衰减。
    // 今天的操作 ×1,窗口最早的操作约 ×DECAY_FLOOR,线性过渡。
    const DECAY_FLOOR = 0.5;
    const span = now.getTime() - windowStart.getTime();
    const recency = (at: Date): number => {
      if (span <= 0) return 1;
      const age = now.getTime() - at.getTime(); // 0(现在)..span(窗口最早)
      return Math.max(DECAY_FLOOR, Math.min(1, 1 - (age / span) * (1 - DECAY_FLOOR)));
    };

    const opsByUid = new Map<string, number>();
    const contribByUid = new Map<string, number>();
    const breakByUid = new Map<string, Map<AdminActivityType, number>>();
    for (const e of events) {
      if (!e.uid) continue;
      opsByUid.set(e.uid, (opsByUid.get(e.uid) ?? 0) + 1);
      contribByUid.set(e.uid, (contribByUid.get(e.uid) ?? 0) + eventWeight(e.type) * recency(e.at));
      let b = breakByUid.get(e.uid);
      if (!b) { b = new Map(); breakByUid.set(e.uid, b); }
      b.set(e.type, (b.get(e.type) ?? 0) + 1);
    }
    const received = await receivedRecognition(windowStart, now, (RECEIVED_WEEKLY_CAP * days) / 7);
    for (const [uid, bonus] of received) {
      // 只对本窗口已有操作的用户加(与周报一致);纯被认可无操作者不新建行。
      if (contribByUid.has(uid)) contribByUid.set(uid, (contribByUid.get(uid) ?? 0) + bonus);
    }
    const topUids = [...contribByUid.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
    const contribUsers = topUids.length
      ? await prisma.user.findMany({ where: { id: { in: topUids.map(([id]) => id) } }, select: { id: true, displayName: true } })
      : [];
    const nameByUid = new Map(contribUsers.map((u) => [u.id, u.displayName]));
    const topContributors = topUids.map(([userId, contribution]) => ({
      userId,
      userName: nameByUid.get(userId) ?? "（已删除）",
      ops: opsByUid.get(userId) ?? 0,
      contribution: Math.round(contribution * 10) / 10,
      breakdown: [...(breakByUid.get(userId)?.entries() ?? [])]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
      received: Math.round((received.get(userId) ?? 0) * 10) / 10,
    }));

    const skillStatus = skillGroups.map((g) => ({ status: g.status, count: g._count }));

    return {
      days,
      trends: { dayLabels: dayKeys.map((k) => k.slice(5)), ...content, activeUsers },
      composition: { byRole, byInteraction, byUpload },
      rankings: { hotDocs, topContributors, docsByRole, skillStatus },
    } satisfies AdminAnalyticsResponse;
  });
}
