// In-app notification center REST. Every endpoint is scoped to the caller
// (recipientId = current user) — a user can only ever see / mutate their own
// notifications. The Feishu push is handled out-of-band by the dispatcher; this
// surface is purely the in-app bell (list / unread count / mark read).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";

const PREF_DEFAULTS = {
  muteLikes: false, muteFavorites: false, muteComments: false, feishuEnabled: true,
  // Web(浏览器桌面)通知偏好:三类事件完成的接收开关 + 桌面弹窗总开关。
  muteAutomation: false, muteMeeting: false, muteImage: false, webEnabled: true,
};
const prefsSchema = z
  .object({
    muteLikes: z.boolean(),
    muteFavorites: z.boolean(),
    muteComments: z.boolean(),
    feishuEnabled: z.boolean(),
    muteAutomation: z.boolean(),
    muteMeeting: z.boolean(),
    muteImage: z.boolean(),
    webEnabled: z.boolean(),
  })
  .partial();

interface NotificationItem {
  id: string;
  type: string;
  articleId: string | null;
  commentId: string | null;
  readAt: string | null;
  createdAt: string;
  actorName: string;
  articleTitle: string;
  excerpt: string | null;
  actorAvatarUrl: string | null;
  // Web 通知类(automation_run / meeting_minutes / image_gen)用:自带标题/正文/站内跳转链接
  // (payload 里存的,非文章互动那套 actor/article 快照)。文章互动类这三项为 null。
  title: string | null;
  body: string | null;
  link: string | null;
}

const TAKE = 30;

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/notifications?cursor= — newest first, keyset paginated.
  app.get<{ Querystring: { cursor?: string } }>("/api/notifications", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const cursor = req.query.cursor?.trim() || undefined;
    const rows = await prisma.notification.findMany({
      where: { recipientId: user.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: TAKE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { select: { displayName: true, avatarUrl: true } } },
    });
    const hasMore = rows.length > TAKE;
    const page = hasMore ? rows.slice(0, TAKE) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    const notifications: NotificationItem[] = page.map((n) => {
      let snap: { actorName?: string; articleTitle?: string; excerpt?: string; title?: string; body?: string; link?: string } = {};
      try {
        snap = JSON.parse(n.payload) as typeof snap;
      } catch {
        /* corrupt snapshot → fall back to defaults below */
      }
      return {
        id: n.id,
        type: n.type,
        articleId: n.articleId,
        commentId: n.commentId,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
        actorName: snap.actorName ?? n.actor?.displayName ?? "有人",
        articleTitle: snap.articleTitle ?? "文档",
        excerpt: snap.excerpt ?? null,
        actorAvatarUrl: n.actor?.avatarUrl ?? null,
        title: snap.title ?? null,
        body: snap.body ?? null,
        link: snap.link ?? null,
      };
    });
    return { notifications, nextCursor };
  });

  // GET /api/notifications/unread-count — drives the bell's red dot.
  app.get("/api/notifications/unread-count", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const count = await prisma.notification.count({ where: { recipientId: user.id, readAt: null } });
    return { count };
  });

  // POST /api/notifications/read — mark specific ids, one article's
  // notifications, or all, as read. Returns the fresh unread count so the
  // client can patch the badge without a refetch.
  //   { ids: [...] }        → 指定几条
  //   { articleId: "..." }  → 与该文章相关的全部未读(打开文章时自动清红点)
  //   {}                    → 全部已读
  app.post<{ Body: { ids?: string[]; articleId?: string } }>("/api/notifications/read", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ids = req.body?.ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) {
      return reply.code(400).send({ error: "invalid_input", message: "ids 必须是字符串数组" });
    }
    const articleId =
      typeof req.body?.articleId === "string" && req.body.articleId.trim() ? req.body.articleId.trim() : undefined;
    const now = new Date();
    await prisma.notification.updateMany({
      where: {
        recipientId: user.id,
        readAt: null,
        ...(Array.isArray(ids) && ids.length > 0 ? { id: { in: ids } } : {}),
        ...(articleId ? { articleId } : {}),
      },
      data: { readAt: now },
    });
    const unread = await prisma.notification.count({ where: { recipientId: user.id, readAt: null } });
    return { ok: true, unread };
  });

  // GET /api/notifications/prefs — current mute/feishu prefs (defaults if unset).
  app.get("/api/notifications/prefs", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const p = await prisma.notificationPref.findUnique({ where: { userId: user.id } });
    return {
      muteLikes: p?.muteLikes ?? PREF_DEFAULTS.muteLikes,
      muteFavorites: p?.muteFavorites ?? PREF_DEFAULTS.muteFavorites,
      muteComments: p?.muteComments ?? PREF_DEFAULTS.muteComments,
      feishuEnabled: p?.feishuEnabled ?? PREF_DEFAULTS.feishuEnabled,
      muteAutomation: p?.muteAutomation ?? PREF_DEFAULTS.muteAutomation,
      muteMeeting: p?.muteMeeting ?? PREF_DEFAULTS.muteMeeting,
      muteImage: p?.muteImage ?? PREF_DEFAULTS.muteImage,
      webEnabled: p?.webEnabled ?? PREF_DEFAULTS.webEnabled,
    };
  });

  // PUT /api/notifications/prefs — partial update; unspecified fields keep their
  // current value (or the default if no row yet).
  app.put("/api/notifications/prefs", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: "参数错误" });
    }
    const current = await prisma.notificationPref.findUnique({ where: { userId: user.id } });
    const merged = {
      muteLikes: parsed.data.muteLikes ?? current?.muteLikes ?? PREF_DEFAULTS.muteLikes,
      muteFavorites: parsed.data.muteFavorites ?? current?.muteFavorites ?? PREF_DEFAULTS.muteFavorites,
      muteComments: parsed.data.muteComments ?? current?.muteComments ?? PREF_DEFAULTS.muteComments,
      feishuEnabled: parsed.data.feishuEnabled ?? current?.feishuEnabled ?? PREF_DEFAULTS.feishuEnabled,
      muteAutomation: parsed.data.muteAutomation ?? current?.muteAutomation ?? PREF_DEFAULTS.muteAutomation,
      muteMeeting: parsed.data.muteMeeting ?? current?.muteMeeting ?? PREF_DEFAULTS.muteMeeting,
      muteImage: parsed.data.muteImage ?? current?.muteImage ?? PREF_DEFAULTS.muteImage,
      webEnabled: parsed.data.webEnabled ?? current?.webEnabled ?? PREF_DEFAULTS.webEnabled,
    };
    const p = await prisma.notificationPref.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...merged },
      update: merged,
    });
    return {
      muteLikes: p.muteLikes,
      muteFavorites: p.muteFavorites,
      muteComments: p.muteComments,
      feishuEnabled: p.feishuEnabled,
      muteAutomation: p.muteAutomation,
      muteMeeting: p.muteMeeting,
      muteImage: p.muteImage,
      webEnabled: p.webEnabled,
    };
  });
}
