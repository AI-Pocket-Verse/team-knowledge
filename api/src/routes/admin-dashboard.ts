import type { FastifyInstance } from "fastify";
import type { AdminDashboardResponse, AdminDashboardUserRow } from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { beijingDayKey, startOfBeijingDayMinus } from "../utils/day.js";
import { loadActivityEvents, pageActivity } from "../services/activity.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;
const ACTIVITY_DEFAULT_DAYS = 30;
const PAGE_SIZE = 10;

export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/dashboard?days=14 — overview + per-user daily activity.
  app.get<{ Querystring: { days?: string } }>("/api/admin/dashboard", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // The per-user activity table (names + emails + individual ops) is
    // admin-only. Every authenticated user gets the SAME aggregate overview
    // with an empty users[] — the UI hides the table for non-admins (see
    // AdminDashboardPage). This is the "聚合公开、个人明细仅管理员" policy.
    const isAdmin = user.isAdmin;

    const parsed = Number(req.query.days);
    const days = Number.isFinite(parsed) ? Math.min(MAX_DAYS, Math.max(1, Math.trunc(parsed))) : DEFAULT_DAYS;

    const now = new Date();
    const windowStart = startOfBeijingDayMinus(now, days - 1);
    const sevenStart = startOfBeijingDayMinus(now, 6);
    const todayKey = beijingDayKey(now);

    const dayKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) dayKeys.push(beijingDayKey(startOfBeijingDayMinus(now, i)));
    const last7Keys = dayKeys.slice(Math.max(0, dayKeys.length - 7));

    // Aggregate overview — served to EVERY authenticated user. totalUsers via
    // count() (not a findMany) so a non-admin request never pulls other users'
    // PII (name/email) into memory at all.
    const [
      totalUsers, activeTodayCount, active7Rows, newUsers7d,
      docTotal, commentTotal, meetingTotal, chatTotal,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.userActiveDay.count({ where: { day: todayKey } }),
      prisma.userActiveDay.findMany({ where: { day: { in: last7Keys } }, select: { userId: true }, distinct: ["userId"] }),
      prisma.user.count({ where: { createdAt: { gte: sevenStart } } }),
      // 去状态后:文档总数 = 全部未删除文档。
      prisma.article.count({ where: { deletedAt: null } }),
      // Count only comments on LIVE docs — a comment on a binned doc must not
      // inflate the overview total, consistent with the doc/meeting counts
      // above (which filter deletedAt: null) and the activity feed.
      prisma.comment.count({ where: { article: { deletedAt: null } } }),
      prisma.meetingSession.count({ where: { deletedAt: null } }),
      prisma.chatMessage.count({ where: { role: "user" } }),
    ]);

    // Per-user daily-activity table — admin only. Skipped entirely (no findMany,
    // no event load) for non-admins, who receive users: [].
    let userRows: AdminDashboardUserRow[] = [];
    if (isAdmin) {
      const dayIndex = new Map(dayKeys.map((k, i) => [k, i]));
      const [users, events] = await Promise.all([
        // Select only the columns the row builder below consumes — drops
        // chatPreference and any future wide columns so the payload per user
        // stays bounded. (No row-count cap: the table intentionally lists
        // every user; bounding the per-row width is the right lever here.)
        prisma.user.findMany({
          select: {
            id: true, displayName: true, email: true, avatarUrl: true,
            isAdmin: true, isActive: true, createdAt: true, lastSeenAt: true,
            roles: { select: { role: { select: { name: true } } } },
          },
        }),
        loadActivityEvents(windowStart),
      ]);

      const rowById = new Map<string, AdminDashboardUserRow>();
      for (const u of users) {
        rowById.set(u.id, {
          id: u.id,
          displayName: u.displayName,
          email: u.email,
          avatarUrl: u.avatarUrl,
          isAdmin: u.isAdmin,
          isActive: u.isActive,
          roles: u.roles.map((ur) => ur.role.name),
          createdAt: u.createdAt.toISOString(),
          lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
          opsToday: 0,
          ops7d: 0,
          daily: new Array(days).fill(0),
        });
      }
      for (const e of events) {
        if (!e.uid) continue;
        const row = rowById.get(e.uid);
        if (!row) continue;
        const key = beijingDayKey(e.at);
        const idx = dayIndex.get(key);
        if (idx !== undefined) row.daily[idx] += 1;
        if (key === todayKey) row.opsToday += 1;
        if (e.at >= sevenStart) row.ops7d += 1;
      }
      userRows = [...rowById.values()].sort(
        (a, b) =>
          b.ops7d - a.ops7d ||
          (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") ||
          b.createdAt.localeCompare(a.createdAt),
      );
    }

    return {
      days,
      dayLabels: dayKeys.map((k) => k.slice(5)),
      overview: {
        totalUsers,
        activeToday: activeTodayCount,
        active7d: active7Rows.length,
        newUsers7d,
        docs: docTotal,
        comments: commentTotal,
        meetings: meetingTotal,
        chatMessages: chatTotal,
      },
      users: userRows,
    } satisfies AdminDashboardResponse;
  });

  // GET /api/admin/activity?userId=&page=1&days=30 — paginated activity feed.
  // No userId → platform-wide (public live stream); with userId → that user's
  // detailed dynamics (admin only).
  app.get<{ Querystring: { userId?: string; page?: string; days?: string } }>("/api/admin/activity", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userId = req.query.userId?.trim() || undefined;
    // The platform-wide feed powers the public live-activity stream; a specific
    // user's detailed activity stays admin-only.
    if (userId && !user.isAdmin) {
      reply.code(403).send({ error: "forbidden", message: "需要管理员权限" });
      return;
    }
    const pageRaw = Number(req.query.page);
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) ? Math.min(MAX_DAYS, Math.max(1, Math.trunc(daysRaw))) : ACTIVITY_DEFAULT_DAYS;

    const windowStart = startOfBeijingDayMinus(new Date(), days - 1);
    return pageActivity({ windowStart, userId, page, pageSize: PAGE_SIZE, viewerIsAdmin: user.isAdmin });
  });
}
