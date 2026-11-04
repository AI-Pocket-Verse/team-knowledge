import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser, trackBestEffort } from "../utils/guards.js";
import { emitNotification } from "../utils/notify/service.js";
import { parseMentions } from "../utils/notify/mentions.js";
import {
  getArticlePermissions,
  getUserRoleIds,
  isArticleCollaborator,
  getEffectiveFolderPermissions,
} from "../utils/permissions.js";

// Comment length is measured in characters (JS string length) so it
// matches the frontend's `maxLength={MAX_COMMENT_CHARS}` + counter.
// Using `Buffer.byteLength` here would silently reject CJK-heavy
// comments well before the user hits the visible limit (a CJK char
// is 3 UTF-8 bytes — 2000 Chinese chars ≈ 6KB).
const MAX_COMMENT_CHARS = 4000;
// Cap distinct @mentions persisted per comment — bounds notification fan-out
// (a single comment can't spam-notify the whole directory).
const MAX_MENTIONS_PER_COMMENT = 20;

interface CommentRow {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string } | null;
  canDelete: boolean;
  parentId: string | null;
  likeCount: number;
  isLiked: boolean;
  replies: CommentRow[];
}

// Shared permission load: anyone with article `canView` can like or
// comment. Returns the article (with folder) and the user's role set
// so callers can short-circuit on permission failure without
// re-querying.
async function loadArticleForSocial(articleId: string, user: { id: string; isAdmin: boolean }) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    include: { folder: true },
  });
  if (!article || article.deletedAt != null) return { kind: "not_found" as const };
  const userRoleIds = await getUserRoleIds(user.id);
  const mp = getEffectiveFolderPermissions({
    user,
    userRoleIds,
    article: { roleId: article.roleId, folder: article.folder },
  });
  // isCollaborator extends canView to per-article grants, so a
  // collaborator on a private-folder article can still like / comment.
  const isCollaborator = await isArticleCollaborator(user.id, article.id);
  const perms = getArticlePermissions({
    folderPermissions: mp,
    article: { createdById: article.createdById },
    userId: user.id, isAdmin: user.isAdmin,
    isCollaborator,
  });
  if (!perms.canView) return { kind: "forbidden" as const };
  return { kind: "ok" as const, article };
}

// Parse @mentions from a comment body, keep only real users who can VIEW this
// article (anti @-injection: a crafted /u/<id> can't pull in strangers or leak
// a draft), persist them, and return the validated ids for notification.
async function persistMentions(
  article: { id: string; createdById: string | null },
  commentId: string,
  body: string,
  actorId: string,
): Promise<string[]> {
  // Cap mentions per comment so one comment can't fan out a notification storm.
  const ids = parseMentions(body).filter((id) => id !== actorId).slice(0, MAX_MENTIONS_PER_COMMENT);
  if (ids.length === 0) return [];
  const existing = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const allowed = existing.map((u) => u.id);
  if (allowed.length === 0) return [];
  await prisma.commentMention.createMany({ data: allowed.map((userId) => ({ commentId, userId })) });
  return allowed;
}

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/articles/:id/like — idempotent. Repeating the call from
  // the same user is a no-op (Prisma's unique constraint catches it
  // and we swallow the P2002).
  app.post<{ Params: { id: string } }>("/api/articles/:id/like", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const res = await loadArticleForSocial(req.params.id, user);
    if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
    if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权点赞" });

    // Create-and-count in one transaction so two concurrent likers
    // can't both observe a stale count and return likeCount=N+1 when
    // the truth is N+2. P2002 (already liked) stays idempotent.
    const count = await prisma.$transaction(async (tx) => {
      try {
        await tx.like.create({ data: { articleId: req.params.id, userId: user.id } });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
          throw err;
        }
      }
      return tx.like.count({ where: { articleId: req.params.id } });
    });
    trackBestEffort(
      emitNotification({ type: "article_like", articleId: req.params.id, actorId: user.id })
        .catch((e) => app.log.warn({ err: e }, "notify like failed")),
    );
    return { isLiked: true, likeCount: count };
  });

  // DELETE /api/articles/:id/like — also idempotent.
  app.delete<{ Params: { id: string } }>("/api/articles/:id/like", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const res = await loadArticleForSocial(req.params.id, user);
    if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
    if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权操作" });

    const count = await prisma.$transaction(async (tx) => {
      await tx.like.deleteMany({ where: { articleId: req.params.id, userId: user.id } });
      return tx.like.count({ where: { articleId: req.params.id } });
    });
    return { isLiked: false, likeCount: count };
  });

  // GET /api/articles/:id/comments?cursor= — top-level comments with
  // replies nested under each one. Capped at TAKE_TOP top-level rows per
  // page at the DB LEVEL (was: load every comment for the article then
  // slice to 200 in JS, which pulled the whole table into memory and made
  // nextCursor a dead `null` so older comments were unreachable). Now a
  // bounded query + a real keyset cursor: pass the returned `nextCursor`
  // (the last top-level comment id) back as `?cursor=` to page forward.
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/api/articles/:id/comments",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const res = await loadArticleForSocial(req.params.id, user);
      if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
      if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权查看评论" });

      const TAKE_TOP = 200;
      // 回复只取本页顶层评论的子孙:从顶层 id 起逐层按 parentId IN 当前层 id 查,
      // 不受整篇文档回复总数影响。每层 LEVEL_CAP 与最大层数 MAX_DEPTH 仅防异常数据
      // (成环/灌水)拖垮请求,正常数据远低于此;超出时只截断更深/更晚的回复。
      const LEVEL_CAP = 5000;
      const MAX_DEPTH = 20;
      const cursor = req.query.cursor?.trim() || undefined;

      // (1) One bounded page of TOP-LEVEL comments, ordered oldest→newest.
      // `take: TAKE_TOP + 1` over-reads one row to detect whether a next
      // page exists without a separate count query. Keyset (cursor) paging
      // skips past the last id of the previous page — stable under inserts,
      // unlike offset paging.
      const topRows = await prisma.comment.findMany({
        where: { articleId: req.params.id, parentId: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: TAKE_TOP + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          author: { select: { id: true, displayName: true } },
          likes: { where: { userId: user.id }, select: { userId: true } },
          _count: { select: { likes: true } },
        },
      });
      const hasMore = topRows.length > TAKE_TOP;
      const topLevel = hasMore ? topRows.slice(0, TAKE_TOP) : topRows;
      const nextCursor = hasMore ? topLevel[topLevel.length - 1]!.id : null;

      // (2) 逐层取回复(任意深度):每层用上一层的 id 做 parentId IN 查询。
      const topIds = topLevel.map((c) => c.id);
      const replyRows: Awaited<ReturnType<typeof fetchLevel>> = [];
      const fetchLevel = (parentIds: string[]) => prisma.comment.findMany({
        where: { articleId: req.params.id, parentId: { in: parentIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: LEVEL_CAP,
        include: {
          author: { select: { id: true, displayName: true } },
          likes: { where: { userId: user.id }, select: { userId: true } },
          _count: { select: { likes: true } },
        },
      });
      let levelIds = topIds;
      for (let depth = 0; depth < MAX_DEPTH && levelIds.length > 0; depth++) {
        const level = await fetchLevel(levelIds);
        replyRows.push(...level);
        levelIds = level.map((r) => r.id);
      }

      type Row = (typeof topRows)[number];
      const toRow = (c: Row, replies: Row[] = []): CommentRow => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        author: c.author,
        canDelete: user.isAdmin || (c.authorId !== null && c.authorId === user.id),
        parentId: c.parentId,
        likeCount: c._count.likes,
        isLiked: c.likes.length > 0,
        replies: replies.map((r) => toRow(r, [])),
      });

      // 按「直接父」建树,从本页顶层往下递归挂载 —— 前端按层级缩进渲染。
      // 祖先不在本页 topIds 里的链自然挂不上(分页语义不变);visited 防御
      // 数据异常成环时的无限递归。
      const childrenOf = new Map<string, Row[]>();
      for (const r of replyRows) {
        const bucket = childrenOf.get(r.parentId!) ?? [];
        bucket.push(r);
        childrenOf.set(r.parentId!, bucket);
      }
      const visited = new Set<string>();
      const toTree = (c: Row): CommentRow => {
        visited.add(c.id);
        const kids = (childrenOf.get(c.id) ?? []).filter((k) => !visited.has(k.id));
        return { ...toRow(c, []), replies: kids.map(toTree) };
      };

      return {
        comments: topLevel.map(toTree),
        nextCursor,
      };
    },
  );

  // POST /api/articles/:id/comments — append. Optional `parentId`
  // turns the comment into a reply on an existing comment of the
  // same article.
  app.post<{ Params: { id: string }; Body: { body?: string; parentId?: string | null } }>(
    "/api/articles/:id/comments",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const res = await loadArticleForSocial(req.params.id, user);
      if (res.kind === "not_found") return reply.code(404).send({ error: "not_found", message: "文档不存在" });
      if (res.kind === "forbidden") return reply.code(403).send({ error: "forbidden", message: "无权评论" });

      const rawBody = req.body?.body ?? "";
      if (typeof rawBody !== "string") {
        return reply.code(400).send({ error: "invalid_input", message: "评论内容格式不正确" });
      }
      const body = rawBody.trim();
      if (body.length === 0) {
        return reply.code(400).send({ error: "invalid_input", message: "评论内容不能为空" });
      }
      if (body.length > MAX_COMMENT_CHARS) {
        return reply.code(413).send({ error: "payload_too_large", message: `评论超过 ${MAX_COMMENT_CHARS} 字上限` });
      }

      let parentAuthorId: string | null = null;
      const parentId = req.body?.parentId ?? null;
      if (parentId) {
        // Verify the parent belongs to this article. 多级回复:parent 可以是
        // 任意一条评论(顶层或回复)。逻辑层级不限,展示层(GET)把整条链
        // 平铺在顶层祖先下并带「回复 @某人」标记,避免深层缩进。
        const parent = await prisma.comment.findUnique({ where: { id: parentId } });
        if (!parent || parent.articleId !== req.params.id) {
          return reply.code(400).send({ error: "invalid_input", message: "回复的评论不存在" });
        }
        parentAuthorId = parent.authorId;
      }

      const created = await prisma.comment.create({
        data: { articleId: req.params.id, authorId: user.id, body, parentId },
        include: { author: { select: { id: true, displayName: true } } },
      });
      // Persist @mentions (awaited — part of creating the comment), then notify
      // author + collaborators + thread participants + mentioned users.
      const mentionedUserIds = await persistMentions(res.article, created.id, body, user.id);
      // Fire-and-forget; tracked so tests can drain it.
      trackBestEffort(
        emitNotification({
          type: parentId ? "comment_reply" : "article_comment",
          articleId: req.params.id,
          actorId: user.id,
          commentId: created.id,
          parentAuthorId,
          mentionedUserIds,
        }).catch((e) => app.log.warn({ err: e }, "notify comment failed")),
      );
      reply.code(201);
      return {
        comment: {
          id: created.id,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          author: created.author,
          canDelete: true,
          parentId: created.parentId,
          likeCount: 0,
          isLiked: false,
          replies: [],
        },
      };
    },
  );

  // POST /api/comments/:id/like — toggle. Returns fresh count + state
  // so the client can patch without an extra GET. Idempotent: liking
  // again is a no-op; unliking when not liked is also a no-op.
  app.post<{ Params: { id: string } }>("/api/comments/:id/like", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment) return reply.code(404).send({ error: "not_found", message: "评论不存在" });
    const articleRes = await loadArticleForSocial(comment.articleId, user);
    if (articleRes.kind !== "ok") {
      // Mask forbidden as 404 to match DELETE-comment leak gate.
      return reply.code(404).send({ error: "not_found", message: "评论不存在" });
    }

    const { count, isLiked } = await prisma.$transaction(async (tx) => {
      try {
        await tx.commentLike.create({ data: { commentId: req.params.id, userId: user.id } });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
          throw err;
        }
      }
      const c = await tx.commentLike.count({ where: { commentId: req.params.id } });
      return { count: c, isLiked: true };
    });
    return { isLiked, likeCount: count };
  });

  app.delete<{ Params: { id: string } }>("/api/comments/:id/like", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment) return reply.code(404).send({ error: "not_found", message: "评论不存在" });
    const articleRes = await loadArticleForSocial(comment.articleId, user);
    if (articleRes.kind !== "ok") {
      return reply.code(404).send({ error: "not_found", message: "评论不存在" });
    }

    const count = await prisma.$transaction(async (tx) => {
      await tx.commentLike.deleteMany({ where: { commentId: req.params.id, userId: user.id } });
      return tx.commentLike.count({ where: { commentId: req.params.id } });
    });
    return { isLiked: false, likeCount: count };
  });

  // DELETE /api/comments/:id — author or admin only. We also re-run
  // the article view-permission gate so a user who lost access can't
  // probe comment IDs and learn which ones exist (404 vs 403 leak).
  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment) return reply.code(404).send({ error: "not_found", message: "评论不存在" });
    const articleRes = await loadArticleForSocial(comment.articleId, user);
    if (articleRes.kind !== "ok") {
      return reply.code(404).send({ error: "not_found", message: "评论不存在" });
    }
    if (!user.isAdmin && comment.authorId !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "无权删除该评论" });
    }
    // FK cascade kills any replies + likes automatically (set up in
    // the schema), so a single delete drops the whole sub-thread.
    await prisma.comment.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
