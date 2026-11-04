import { L } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser, trackBestEffort } from "../utils/guards.js";
import { emitNotification } from "../utils/notify/service.js";
import { getArticlePermissions, asFolderVisibility, getUserRoleIds, isArticleCollaborator, getCollaboratorArticleIds, getEffectiveFolderPermissions } from "../utils/permissions.js";
import { bookmarkCreateSchema } from "../schemas/article.js";
import { filterVisibleInboundRefs } from "../utils/inboundRefs.js";

export async function bookmarkRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/bookmarks", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = bookmarkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const a = await prisma.article.findUnique({
      where: { id: parsed.data.articleId },
      include: { folder: true },
    });
    if (!a || a.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "文档不存在", "Document not found") });

    const userRoleIds = await getUserRoleIds(user.id);
    const mp = getEffectiveFolderPermissions({
      user: { id: user.id, isAdmin: user.isAdmin },
      userRoleIds,
      article: { roleId: a.roleId, folder: a.folder },
    });
    const isCollaborator = await isArticleCollaborator(user.id, a.id);
    const perms = getArticlePermissions({
      folderPermissions: mp,
      article: { createdById: a.createdById },
      userId: user.id,
      isAdmin: user.isAdmin,
      isCollaborator,
    });
    if (!perms.canBookmark) return reply.code(403).send({ error: "forbidden", message: L(req, "无权收藏该文档", "No permission to bookmark this document") });

    // Create-and-count in one transaction so two concurrent bookmarkers
    // can't both observe a stale count and return bookmarkCount=N+1
    // when the truth is N+2. P2002 (already bookmarked) stays
    // idempotent — we swallow it and still return the current count
    // alongside the existing row's createdAt.
    try {
      const { bm, count } = await prisma.$transaction(async (tx) => {
        const created = await tx.bookmark.create({ data: { userId: user.id, articleId: a.id } });
        const c = await tx.bookmark.count({ where: { articleId: a.id } });
        return { bm: created, count: c };
      });
      trackBestEffort(
        emitNotification({ type: "article_favorite", articleId: a.id, actorId: user.id })
          .catch((e) => app.log.warn({ err: e }, "notify favorite failed")),
      );
      reply.code(201);
      return {
        bookmark: { userId: bm.userId, articleId: bm.articleId, createdAt: bm.createdAt.toISOString() },
        isBookmarked: true,
        bookmarkCount: count,
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(409).send({ error: "conflict", message: L(req, "已经收藏过了", "Already bookmarked") });
      }
      throw e;
    }
  });

  app.delete<{ Params: { articleId: string } }>("/api/bookmarks/:articleId", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // Same delete-and-count transaction as the like endpoint, so the
    // returned count reflects the post-delete truth even under
    // concurrent unbookmarks.
    const count = await prisma.$transaction(async (tx) => {
      await tx.bookmark.deleteMany({
        where: { userId: user.id, articleId: req.params.articleId },
      });
      return tx.bookmark.count({ where: { articleId: req.params.articleId } });
    });
    return { isBookmarked: false, bookmarkCount: count };
  });

  app.get("/api/bookmarks", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // Server-side cap. A power user with 500+ bookmarks would otherwise
    // ship a multi-MB JSON on every page load.
    const takeRaw = Number((req.query as { take?: string } | undefined)?.take ?? 200);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 500) : 200;

    // Bookmarks whose article is in the recycle bin drop out of the
    // list (and the count) until the doc is restored or purged.
    const totalCount = await prisma.bookmark.count({ where: { userId: user.id, article: { deletedAt: null } } });
    const rows = await prisma.bookmark.findMany({
      where: { userId: user.id, article: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      take,
      // Explicit select — contentMarkdown is OMITTED so a user's bookmark
      // list doesn't pull every starred article's full body.
      select: {
        createdAt: true,
        article: {
          select: {
            id: true,
            title: true,

            folderId: true,
            roleId: true,
            sortOrder: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
            folder: { include: { role: true } },
            role: true,
            createdBy: { select: { id: true, displayName: true } },
            inboundRefs: {
              // Hide backlinks whose source doc is in the recycle bin.
              where: { fromArticle: { deletedAt: null } },
              include: { fromArticle: { select: { id: true, title: true, folderId: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } } } },
            },
            _count: { select: { versions: true } },
          },
        },
      },
    });

    const userRoleIds = await getUserRoleIds(user.id);
    // Bulk-load per-article collaborator flags in one query so a user
    // who bookmarked a private-folder article they collaborate on
    // still sees the row instead of being filtered out by canView.
    const collabIds = await getCollaboratorArticleIds(user.id, rows.map((r) => r.article.id));

    const visible = rows
      .map((r) => {
        const mp = getEffectiveFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          article: { roleId: r.article.roleId, folder: r.article.folder },
        });
        const perms = getArticlePermissions({
          folderPermissions: mp,
          article: { createdById: r.article.createdById },
          userId: user.id,
          isAdmin: user.isAdmin,
          isCollaborator: collabIds.has(r.article.id),
        });
        return { row: r, mp, perms };
      })
      .filter(({ perms }) => perms.canView);

    return {
      bookmarks: visible.map(({ row: r, perms }) => {
        const a = r.article;
        return {
          createdAt: r.createdAt.toISOString(),
          article: {
            id: a.id, title: a.title,

            folderId: a.folderId,
            roleId: a.roleId,
            sortOrder: a.sortOrder,
            createdById: a.createdById,
            createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
            permissions: perms,
            createdBy: a.createdBy,
            isBookmarked: true,
            folder: a.folder
              ? {
                  id: a.folder.id, name: a.folder.name, description: a.folder.description,
                  roleId: a.folder.roleId, visibility: asFolderVisibility(a.folder.visibility),
                  templateType: a.folder.templateType, createdById: a.folder.createdById,
                  createdAt: a.folder.createdAt.toISOString(), updatedAt: a.folder.updatedAt.toISOString(),
                }
              : null,
            role: {
              id: a.role.id, name: a.role.name, description: a.role.description,
              color: a.role.color, createdAt: a.role.createdAt.toISOString(),
            },
            inboundRefs: filterVisibleInboundRefs(
              a.inboundRefs,
              { id: user.id, isAdmin: user.isAdmin },
              userRoleIds,
            ),
            versionsCount: a._count.versions,
          },
        };
      }),
      hasMore: totalCount > rows.length,
    };
  });
}
