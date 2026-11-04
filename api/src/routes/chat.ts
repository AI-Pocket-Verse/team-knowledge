import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { chatMessageCreateSchema } from "../schemas/chat.js";
import { renderChatSharePng } from "../services/chat-share-image/render.js";
import { shareImageSemaphore } from "../utils/concurrency.js";
import { loadChatImageDataUris, newEmbedBudget } from "../services/uploads/image-store.js";
import { openSse, abortOnClientClose, type SseWriter } from "../utils/sse.js";
import { getUserRoleIds, getCollaboratorArticleIds, getEffectiveFolderPermissions } from "../utils/permissions.js";
import {
  runChatTurn, ChatBusyError, decodeCited, decodeMentions,
} from "../services/chat/runChatTurn.js";
import {
  createConversation, getOwnedConversation,
  listConversations, renameConversation, pinConversation, deleteConversation, deriveTitle,
} from "../services/chat/conversations.js";
import { subscribeChatEvents, unsubscribeChatEvents } from "../services/chat/chat-events.js";
import { ASSISTANT_NAME } from "../utils/assistant.js";

// 分享图片的总行数上限；超出直接拒绝，未超出但画布过高的部分由排版层截断。
const SHARE_IMAGE_MAX_LINES = 5000;
// 排队等待与单张渲染的上限。
const SHARE_IMAGE_QUEUE_MS = 15_000;
const SHARE_IMAGE_RENDER_MS = 30_000;

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // 正在生成分享图的成员(每人同时一张,见 /api/chat/share-image)。
  const shareImageUsers = new Set<string>();
  // Realtime nudge channel:turns that land off-page(飞书单聊、助手后台通知)
  // publish here and the web UI refetches the conversation. Mirrors the
  // dashboard stream wiring (auth before hijack, unsubscribe on close);
  // periodic pings keep idle connections alive through nginx's read timeout.
  app.get("/api/chat/stream", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return; // 401/403 already sent as JSON — stream not opened.

    const sse = openSse(reply);
    sse.send("hello", { at: new Date().toISOString() });
    subscribeChatEvents(user.id, sse);
    const ping = setInterval(() => sse.send("ping", {}), 25_000);

    req.raw.on("close", () => {
      clearInterval(ping);
      unsubscribeChatEvents(user.id, sse);
      sse.end();
    });
  });

  app.get<{ Querystring: { conversationId?: string; before?: string; limit?: string } }>("/api/chat/conversation", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!req.query.conversationId) return reply.code(400).send({ error: "invalid_input", message: "缺少 conversationId" });
    const conv = await getOwnedConversation(user.id, req.query.conversationId);
    if (!conv) return reply.code(404).send({ error: "not_found", message: "会话不存在" });

    // keyset 分页:默认取最近 limit 条(limit≤100);before=游标消息 id → 取更早一页。
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 100;
    const before = req.query.before;
    // before 必须属于本会话,否则忽略(防跨会话/伪造游标导致的 Prisma cursor 异常)。
    let cursorOk = false;
    if (before) {
      const c = await prisma.chatMessage.findFirst({ where: { id: before, conversationId: conv.id }, select: { id: true } });
      cursorOk = !!c;
    }

    // 按 (createdAt, id) 倒序取 limit+1 条(多取一条判断 hasMoreOlder),再反转成升序展示。
    // 倒序 + cursor 让「最近 N 条」与「更早一页」走同一查询;cuid 单调,id 作 createdAt 同毫秒的稳定 tiebreak。
    const page = await prisma.chatMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursorOk ? { cursor: { id: before! }, skip: 1 } : {}),
    });
    const hasMoreOlder = page.length > limit;
    const messages = (hasMoreOlder ? page.slice(0, limit) : page).reverse();

    // Collect every cited article id, fetch in one query, and re-filter by
    // the caller's current permissions. A message persisted last week may
    // reference an article in a folder the user just lost access to —
    // we drop those refs (the [#N] marker stays as plain text). If an
    // article was deleted entirely, same outcome.
    const decodedPerMessage = messages.map((m) => ({ msg: m, ids: decodeCited(m.citedArticleIds), mentions: decodeMentions(m.mentions) }));
    const allIds = Array.from(new Set(decodedPerMessage.flatMap((d) => d.ids)));
    let articleById = new Map<string, { id: string; title: string; folderId: string | null; roleId: string; folder: { roleId: string; visibility: string } | null }>();
    if (allIds.length > 0) {
      const articles = await prisma.article.findMany({
        where: { id: { in: allIds }, deletedAt: null },
        select: {
          id: true, title: true, folderId: true, roleId: true,
          folder: { select: { roleId: true, visibility: true } },
        },
      });
      const userRoleIds = await getUserRoleIds(user.id);
      const collabIds = await getCollaboratorArticleIds(user.id, allIds);
      const visible = articles.filter((a) => {
        if (collabIds.has(a.id)) return true;
        const mp = getEffectiveFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          article: { roleId: a.roleId, folder: a.folder },
        });
        return mp.canView;
      });
      articleById = new Map(visible.map((a) => [a.id, a]));
    }

    return {
      id: conv.id,
      title: conv.title,
      isFeishu: conv.singletonKey === "feishu",
      summary: conv.summary,
      summaryUpToMessageId: conv.summaryUpToMessageId,
      summaryUpdatedAt: conv.summaryUpdatedAt?.toISOString() ?? null,
      hasMoreOlder,
      messages: decodedPerMessage.map(({ msg, ids, mentions }) => {
        const citedRefs = ids
          .map((id, i) => {
            const a = articleById.get(id);
            if (!a) return null;
            return { n: i + 1, articleId: a.id, title: a.title, folderId: a.folderId, roleId: a.roleId };
          })
          .filter((r): r is { n: number; articleId: string; title: string; folderId: string | null; roleId: string } => r !== null);
        return {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          // 生图轮叙述存于 thinking → 回放时带上,前端重建可折叠「思考过程」卡(Null → 不展示)。
          thinking: msg.thinking ?? undefined,
          citedArticleIds: ids,
          citedRefs,
          mentions,
          images: decodeCited(msg.images), // 同款宽容 JSON 数组解码(null → [])
          createdAt: msg.createdAt.toISOString(),
        };
      }),
    };
  });

  // Debug / introspection endpoint — lets the UI (or an admin) see what the
  // rolling summarizer has captured, plus a `messagesSinceSummary` count.
  app.get<{ Querystring: { conversationId?: string } }>("/api/chat/conversation/summary", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!req.query.conversationId) return reply.code(400).send({ error: "invalid_input", message: "缺少 conversationId" });
    const conv = await getOwnedConversation(user.id, req.query.conversationId);
    if (!conv) return reply.code(404).send({ error: "not_found", message: "会话不存在" });
    let messagesSinceSummary = 0;
    if (conv.summaryUpToMessageId) {
      const anchor = await prisma.chatMessage.findUnique({
        where: { id: conv.summaryUpToMessageId },
        select: { createdAt: true },
      });
      if (anchor) {
        messagesSinceSummary = await prisma.chatMessage.count({
          where: {
            conversationId: conv.id,
            createdAt: { gte: anchor.createdAt },
            NOT: { id: conv.summaryUpToMessageId },
          },
        });
      }
    } else {
      messagesSinceSummary = await prisma.chatMessage.count({
        where: { conversationId: conv.id },
      });
    }
    return {
      summary: conv.summary,
      summaryUpToMessageId: conv.summaryUpToMessageId,
      summaryUpdatedAt: conv.summaryUpdatedAt?.toISOString() ?? null,
      messagesSinceSummary,
    };
  });

  app.delete<{ Querystring: { conversationId?: string } }>("/api/chat/conversation", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const conv = req.query.conversationId ? await getOwnedConversation(user.id, req.query.conversationId) : null;
    if (!conv) return reply.code(404).send({ error: "not_found", message: "会话不存在" });
    await prisma.chatMessage.deleteMany({ where: { conversationId: conv.id } });
    // Also reset rolling-summary state. Without this, the next chat turn
    // still injects a stale [此前对话摘要] block referencing deleted messages,
    // and summaryUpToMessageId would point at a now-missing row.
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { summary: null, summaryUpToMessageId: null, summaryUpdatedAt: null },
    });
    return reply.code(204).send();
  });

  // 会话列表(飞书置顶 + 其余按 lastMessageAt 倒序)。
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/chat/conversations", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const rawOffset = req.query.offset ? Number(req.query.offset) : undefined;
    return listConversations(user.id, {
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      offset: Number.isFinite(rawOffset) ? rawOffset : undefined,
    });
  });

  // 重命名 / 置顶会话(归属校验)。pinned 是布尔 → 置顶/取消置顶;否则按 title 重命名。
  app.patch<{ Params: { id: string }; Body: { title?: string; pinned?: boolean } }>("/api/chat/conversations/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (typeof req.body?.pinned === "boolean") {
      const ok = await pinConversation(user.id, req.params.id, req.body.pinned);
      if (!ok) return reply.code(404).send({ error: "not_found", message: "会话不存在" });
      return { ok: true };
    }
    const title = (req.body?.title ?? "").trim();
    if (!title) return reply.code(400).send({ error: "invalid_input", message: "标题不能为空" });
    const ok = await renameConversation(user.id, req.params.id, title);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "会话不存在" });
    return { ok: true };
  });

  // 删除会话(级联删消息,归属校验)。
  app.delete<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ok = await deleteConversation(user.id, req.params.id);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "会话不存在" });
    return reply.code(204).send();
  });

  // Per-user rate limit: at most 20 chat requests/minute. Independent of the
  // global 300/min cap; prevents one user from monopolizing the 5 LLM slots.
  app.post("/api/chat/message", {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: "1 minute",
        keyGenerator: (req: { user?: { id?: string } | null; ip: string }) =>
          req.user?.id ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = chatMessageCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }

    // 会话解析:带 conversationId 且归属本人 → 用之;否则惰性新建一条(首发即落库)。
    const requested = parsed.data.conversationId;
    const owned = requested ? await getOwnedConversation(user.id, requested) : null;
    const conversationId = owned
      ? owned.id
      : (await createConversation(user.id, deriveTitle(parsed.data.content))).id;

    const ac = new AbortController();
    abortOnClientClose(reply, ac);

    // Lazy SSE: opened on the FIRST streamed chunk (`cited`). This keeps the
    // pre-stream HTTP 429 (busy) behavior intact — ChatBusyError is thrown
    // before any chunk, so the SSE is still unopened and we can reply 429 JSON.
    // Held in a ref object so the assignment inside `ensureSse` doesn't trip
    // TS's flow-narrowing (a closure-assigned `let` narrows to `null` forever).
    const sseRef: { w: SseWriter | null } = { w: null };
    const ensureSse = (): SseWriter => (sseRef.w ??= openSse(reply));

    try {
      await runChatTurn({
        user: { id: user.id, isAdmin: user.isAdmin, chatPreference: user.chatPreference },
        conversationId,
        text: parsed.data.content,
        scope: "web",
        articleId: parsed.data.articleId ?? undefined,
        mentions: parsed.data.mentions ?? [],
        images: parsed.data.images ?? [],
        signal: ac.signal,
        log: req.log,
        onChunk: (c) => {
          const w = ensureSse();
          if (c.type === "cited") w.send("cited", { articleIds: c.articleIds, refs: c.refs });
          else if (c.type === "token") w.send("token", { text: c.text });
          else if (c.type === "thinking") w.send("thinking", { text: c.text });
          else if (c.type === "thinking_end") w.send("thinking_end", {});
          else if (c.type === "done") w.send("done", { ok: true, conversationId });
          else if (c.type === "error") w.send("error", { message: c.message });
        },
      });
    } catch (e) {
      if (e instanceof ChatBusyError) {
        // Pre-stream: no SSE opened → original 429 JSON behavior.
        if (!sseRef.w) { reply.code(429).send({ error: "busy", message: e.message }); return; }
        sseRef.w.send("error", { message: e.message });
      } else {
        ensureSse().send("error", { message: (e as Error).message });
      }
    }
    sseRef.w?.end();
  });

  // POST /api/chat/share-image — render selected chat messages into a PNG card
  // for sharing. The client posts the selected turns (the user's OWN chat, same
  // as the share-to-doc flow builds its markdown client-side); we lay them out
  // as a chat-bubble SVG and rasterize server-side (reusing the weekly-report
  // image stack). Returns the PNG binary directly.
  const shareImageSchema = z.object({
    title: z.string().max(120).optional(),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      // Attached image urls (/uploads/<file>). Resolved + ownership-checked
      // server-side before embedding; bad/foreign urls are silently skipped.
      images: z.array(z.string()).max(20).optional(),
    })).min(1).max(100),
  });

  app.post("/api/chat/share-image", {
    // 渲染在独立子进程里跑(不阻塞事件循环),但每张要占一个 CPU 核数秒到十几秒,
    // 且全局同一时间只渲染一张,所以这条路由另设较紧的按人限流(同上面的 LLM 路由)。
    config: {
      rateLimit: {
        max: 12,
        timeWindow: "1 minute",
        keyGenerator: (req: { user?: { id?: string } | null; ip: string }) =>
          req.user?.id ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = shareImageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    // Bound total content so a huge selection can't blow up render time / size.
    const totalChars = parsed.data.messages.reduce((n, m) => n + m.content.length, 0);
    if (totalChars > 60_000) {
      return reply.code(400).send({ error: "too_large", message: "选中的内容过多，请减少条数后再生成图片" });
    }
    // 每行都是一个排版单元；行数过多时 400，免得白白解析。画布超高的部分由排版层截断。
    const totalLines = parsed.data.messages.reduce((n, m) => n + m.content.split("\n").length, 0);
    if (totalLines > SHARE_IMAGE_MAX_LINES) {
      return reply.code(400).send({ error: "too_large", message: "选中的内容行数过多，请减少条数后再生成图片" });
    }
    const dateLabel = `摘自 ${ASSISTANT_NAME} 对话 · ${new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date())}`;
    // 同一成员同时只生成一张:否则一个人连发就能占满全局唯一的渲染名额,让其他人一直 503。
    // 在读图之前占位(并发请求不必各自先把图读完);占位与全局名额一起在渲染进程结束后释放。
    if (shareImageUsers.has(user.id)) {
      return reply.code(429).send({ error: "share_image_in_progress", message: "上一张图片还在生成，请稍候" });
    }
    shareImageUsers.add(user.id);
    // Resolve each message's attached images (the user's OWN uploads) into
    // embeddable data URIs. 字节与解码像素预算由整张图的所有消息共享(不按消息重置),
    // 没放入的计数后在图里提示。Foreign/missing urls are skipped silently.
    const messagesForRender = [] as { role: "user" | "assistant"; content: string; images: string[] }[];
    const budget = newEmbedBudget();
    let skippedImages = 0;
    try {
      for (const m of parsed.data.messages) {
        let images: string[] = [];
        if (m.images?.length) {
          const r = await loadChatImageDataUris(user.id, m.images, budget);
          images = r.uris;
          skippedImages += r.skipped;
        }
        messagesForRender.push({ role: m.role, content: m.content, images });
      }
    } catch (e) {
      shareImageUsers.delete(user.id);
      throw e;
    }
    let releaseSlot: () => void;
    try {
      releaseSlot = await shareImageSemaphore.acquire(SHARE_IMAGE_QUEUE_MS);
    } catch {
      shareImageUsers.delete(user.id);
      return reply.code(503).send({ error: "share_image_busy", message: "正在生成其他图片，请稍后再试" });
    }
    const finishUser = () => { shareImageUsers.delete(user.id); releaseSlot(); };
    let png: Buffer;
    try {
      // 名额在渲染进程结束后才释放(onExit);超时会结束渲染进程并回 503。
      png = await renderChatSharePng(messagesForRender, {
        title: parsed.data.title, dateLabel, skippedImages, timeoutMs: SHARE_IMAGE_RENDER_MS, onExit: finishUser,
      });
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, "share image render failed");
      return reply.code(503).send({ error: "share_image_failed", message: "图片生成超时或失败，请减少内容后再试" });
    }
    reply.header("Content-Type", "image/png");
    reply.header("Content-Disposition", 'inline; filename="assistant-chat.png"');
    reply.header("Cache-Control", "no-store");
    return reply.send(png);
  });
}
