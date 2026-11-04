import { L, requestLang, type Lang } from "../utils/lang.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { addDismissed } from "../services/article-review/dismiss.js";
import { clearReviewNotifications } from "../services/article-review/notify.js";
import { callReviewLlm, fetchRelatedDocs, contentHash, type ReviewLlmDiag } from "../services/article-review/review.js";
import { hashReviewFindings, type HashedReviewFinding } from "../services/article-review/findings.js";
import { OPTIMIZE_SYSTEM, buildOptimizeUserMessage } from "../services/article-review/prompt.js";
import { parseOptimizeEdits, applyOptimizeEdits } from "../services/article-review/optimize-patch.js";
import { markRoleSkillStale } from "../services/role-skill/stale.js";
import {
  getFolderPermissions, getArticlePermissions, asFolderVisibility,
  getUserRoleIds, getCollaboratorArticleIds, isArticleCollaborator,
  getEffectiveFolderPermissions, getRoleDirectPermissions,
} from "../utils/permissions.js";
import {
  articleCreateSchema,
  articleUpdateSchema,
  articleBulkSchema,
  articleSearchSchema,
  articleMoveSchema,
  articleReorderSchema,
} from "../schemas/article.js";
import { filterVisibleInboundRefs } from "../utils/inboundRefs.js";
import { syncArticleLinks } from "../utils/articleLinks.js";
import { buildArticleExport } from "../utils/articleExport.js";
import { uniqueArticleId } from "../utils/shortId.js";
import { openSse, abortOnClientClose } from "../utils/sse.js";

// Fallback title for docs the user saves without typing anything in
// the title input. The editor sends "" (the create+update schemas
// allow it); the storage layer is the single point that decides the
// human-readable replacement so every other consumer (list views,
// search, export, version snapshots) sees a non-empty title.
// 没填标题时存的默认标题，按创建人的界面语言写；前端 web/src/pages/ArticlePage.tsx 两种写法都认作「未填」。
const normalizeTitle = (raw: string, lang: Lang) => (raw.trim() === "" ? L(lang, "未命名文档", "Untitled document") : raw);

// List-shaped article — contentMarkdown is intentionally NOT loaded
// here. Pulling full bodies for every row would put MB of markdown
// per article into the Node heap just to compute a 140-char preview.
// We fetch only the first ~2KB of each body via a separate
// $queryRaw substring call below.
//
// After the folders/docs refactor, `folder` may be null (role-direct
// docs); `role` is now eager-loaded directly off the article so the
// response shape can always render role color/name regardless of
// whether the doc sits inside a folder.
type DbArticle = Prisma.ArticleGetPayload<{
  select: {
    id: true;
    title: true;
    folderId: true;
    roleId: true;
    sortOrder: true;
    createdById: true;
    createdAt: true;
    updatedAt: true;
    folder: { include: { role: true } };
    role: true;
    createdBy: { select: { id: true; displayName: true } };
    _count: { select: { likes: true; comments: true } };
  };
}>;

const ARTICLE_SELECT = {
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
  _count: { select: { likes: true, comments: true } },
} as const;

const PREVIEW_LEN = 140;
const PREVIEW_SCAN_BYTES = 2000;

// Best-effort plain-text preview of a markdown body. We strip the
// noisy markdown syntax (headings, code, images, link wrappers,
// inline markers) so the list card shows readable prose instead of
// raw `#` and `**`. Scan only the first ~2KB — a card preview never
// needs more, and bounding the scan keeps large (10MB+) articles fast.
export function extractPreview(md: string): string {
  let s = md.slice(0, PREVIEW_SCAN_BYTES);
  s = s.replace(/^---\n[\s\S]*?\n---\n/, "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/^[\s>#*+-]+/gm, "");
  s = s.replace(/[*_`~]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > PREVIEW_LEN ? s.slice(0, PREVIEW_LEN) + "…" : s;
}

export function extractFirstImage(md: string): string | null {
  const m = md.slice(0, PREVIEW_SCAN_BYTES).match(/!\[[^\]]*\]\(([^)\s]+)/);
  return m ? m[1] : null;
}

function toRole(r: { id: string; name: string; description: string | null; color: string | null; createdAt: Date }) {
  return {
    id: r.id, name: r.name, description: r.description, color: r.color,
    createdAt: r.createdAt.toISOString(),
  };
}

function toFolder(m: { id: string; name: string; description: string | null; roleId: string; visibility: string; templateType: string; createdById: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: m.id, name: m.name, description: m.description, roleId: m.roleId,
    visibility: asFolderVisibility(m.visibility), templateType: m.templateType,
    createdById: m.createdById,
    createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
  };
}

interface ToSummaryOpts {
  user: { id: string; isAdmin: boolean };
  userRoleIds: Set<string>;
  bookmarkedIds: Set<string>;
  likedIds: Set<string>;
  collaboratorArticleIds: Set<string>;
  bodySnippets: Map<string, string>;
}

function toSummary(a: DbArticle, opts: ToSummaryOpts) {
  const mp = getEffectiveFolderPermissions({
    user: opts.user,
    userRoleIds: opts.userRoleIds,
    article: { roleId: a.roleId, folder: a.folder },
  });
  const perms = getArticlePermissions({
    folderPermissions: mp,
    article: { createdById: a.createdById },
    userId: opts.user.id,
    isAdmin: opts.user.isAdmin,
    isCollaborator: opts.collaboratorArticleIds.has(a.id),
  });
  const snippet = opts.bodySnippets.get(a.id) ?? "";
  return {
    id: a.id,
    title: a.title,
    folderId: a.folderId,
    roleId: a.roleId,
    sortOrder: a.sortOrder,
    createdById: a.createdById,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    permissions: perms,
    createdBy: a.createdBy,
    isBookmarked: opts.bookmarkedIds.has(a.id),
    preview: extractPreview(snippet),
    firstImage: extractFirstImage(snippet),
    likeCount: a._count.likes,
    isLiked: opts.likedIds.has(a.id),
    commentCount: a._count.comments,
  };
}

// De-dup window for per-user document-view tracking. A second view of
// the same doc by the same user within this window doesn't bump the PV
// counter — mirrors the activity-stamp throttle in guards.ts so a reader
// scrolling / re-opening a doc doesn't inflate 访问量.
const VIEW_DEDUP_MS = 30 * 60 * 1000;

// Soft edit-lock TTL. A lock is ACTIVE only while its editingAt heartbeat
// is within this window of now; an older stamp is treated as free (a
// crashed / closed editor never wedges the doc). The FE refreshes the lock
// well inside this window via POST /api/articles/:id/edit-lock.
const LOCK_TTL_MS = 45000;

// Is there an ACTIVE lock right now? True iff editingById is set AND the
// heartbeat is fresh (within LOCK_TTL_MS). Stale locks read as free.
function isLockActive(editingById: string | null, editingAt: Date | null, now = Date.now()): boolean {
  return editingById != null && editingAt != null && editingAt.getTime() >= now - LOCK_TTL_MS;
}

// 容错解析 reviewFindings JSON;坏数据返回 null(不让脏数据 500 掉详情接口)。
function safeParseFindings(json: string): unknown[] | null {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// 读已存的 reviewFindings 并重算 hash(脏数据/非数组 → []);review action 端点共用,
// 避免裸 JSON.parse 在损坏数据上 500。重算 hash 与 reviewArticle 同源(category+problem)。
function storedHashedFindings(json: string | null): HashedReviewFinding[] {
  const arr = json ? safeParseFindings(json) : null;
  return arr ? hashReviewFindings(arr as Parameters<typeof hashReviewFindings>[0]) : [];
}

// 一键优化的「同篇在途」闸:防止同一文档被并发优化(双标签页/连点/直连 API)各起一个
// ≤180s 的 LLM 任务挤占共享 chatSemaphore。单进程内 Set 足够。
const optimizeInFlight = new Set<string>();

// Best-effort, fire-and-forget document-view stamp. Never blocks or fails
// the request (mirrors recordActivity in utils/guards.ts) — telemetry only
// (powers the doc-detail dialog's PV / 独立访客 / 谁看过). Called AFTER the
// canView gate so we only record views the user was actually allowed.
// De-dup per (article, user) per VIEW_DEDUP_MS: first view creates the row
// (viewCount 1); a view ≥ window after lastViewedAt bumps viewCount +
// lastViewedAt; otherwise no-op. Recorded for ALL viewers, author included.
function recordArticleView(articleId: string, userId: string): void {
  const now = new Date();
  // The cutoff: a view is only counted if the row's lastViewedAt is OLDER
  // than this (i.e. the previous view was ≥ window ago) — or the row doesn't
  // exist yet (first view).
  const windowStart = new Date(now.getTime() - VIEW_DEDUP_MS);
  void (async () => {
    // First view: create the row. If a concurrent first view already created
    // it (P2002), fall through to the conditional bump below — no double-count
    // because the bump is window-guarded.
    try {
      await prisma.articleView.create({
        data: { articleId, userId, firstViewedAt: now, lastViewedAt: now, viewCount: 1 },
      });
      return;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    }
    // Row exists. Bump viewCount + lastViewedAt ONLY when the prior view is
    // outside the de-dup window. The `lastViewedAt < windowStart` predicate
    // runs atomically in the WHERE, so two concurrent opens inside the same
    // window can't both pass it (the first bump moves lastViewedAt to `now`,
    // which is ≥ windowStart, so the second matches 0 rows). This closes the
    // read-then-upsert TOCTOU where both passed a stale dedup check and both
    // incremented. A repeat view inside the window updates 0 rows = no-op.
    await prisma.articleView.updateMany({
      where: { articleId, userId, lastViewedAt: { lt: windowStart } },
      data: { viewCount: { increment: 1 }, lastViewedAt: now },
    });
  })().catch(() => { /* best-effort: a failed view stamp must never break a request */ });
}

// 「最后修改人」显示名 —— 每篇文档最近一条带作者的 ArticleVersion(Article 本身无
// updatedById)。用于搜索结果 / 最近浏览行的「{editorName} 在 X 修改过」。返回
// Map(articleId → displayName);缺省(无带作者版本)由调用方回退到创建者。
async function editorNamesByArticle(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  // 单次查询取这批文档「带作者」的版本,全局按 createdAt 倒序;内存里按 articleId 取
  // 首次出现 = 该文档最新一条带作者版本。比逐篇 findFirst 省 N-1 次往返,命中
  // @@index([articleId, createdAt])。作者已删的版本(authorId null)在 where 跳过。
  const versions = await prisma.articleVersion.findMany({
    where: { articleId: { in: ids }, authorId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { articleId: true, author: { select: { displayName: true } } },
  });
  const map = new Map<string, string>();
  for (const v of versions) {
    if (!map.has(v.articleId) && v.author) map.set(v.articleId, v.author.displayName);
  }
  return map;
}

export async function articleRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/folders/:folderId/articles — list a folder's docs.
  app.get<{ Params: { folderId: string } }>("/api/folders/:folderId/articles", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const fold = await prisma.folder.findUnique({ where: { id: req.params.folderId } });
    if (!fold || fold.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "目录不存在", "Folder not found") });

    const userRoleIds = await getUserRoleIds(user.id);
    const mp = getFolderPermissions({
      user: { id: user.id, isAdmin: user.isAdmin }, userRoleIds,
      folder: { roleId: fold.roleId, visibility: asFolderVisibility(fold.visibility) },
    });
    if (!mp.canView) return reply.code(403).send({ error: "forbidden", message: L(req, "无权访问该目录", "No permission to access this folder") });

    const takeRaw = Number((req.query as { take?: string } | undefined)?.take ?? 200);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 500) : 200;

    // 去草稿隐私后,目录公开可读 → 该目录下全部未删除文档都可见(canView 恒真)。
    const viewableWhere: Prisma.ArticleWhereInput = {
      folderId: fold.id,
      deletedAt: null,
    };

    const articles = await prisma.article.findMany({
      where: viewableWhere,
      // Canonical sibling order — must match the sidebar tree (workspace.ts)
      // and the folder feed (me.ts) so all folder doc-list views agree.
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take,
      select: ARTICLE_SELECT,
    });
    const totalCount = await prisma.article.count({ where: viewableWhere });
    const hasMore = totalCount > articles.length;

    const ids = articles.map((a) => a.id);
    const [bookmarks, likes, collaboratorArticleIds, snippetRows] = await Promise.all([
      prisma.bookmark.findMany({ where: { userId: user.id, articleId: { in: ids } }, select: { articleId: true } }),
      prisma.like.findMany({ where: { userId: user.id, articleId: { in: ids } }, select: { articleId: true } }),
      getCollaboratorArticleIds(user.id, ids),
      ids.length === 0
        ? Promise.resolve([] as Array<{ id: string; snippet: string }>)
        : prisma.$queryRaw<Array<{ id: string; snippet: string }>>`
            SELECT id, substr(contentMarkdown, 1, 2048) AS snippet
            FROM Article
            WHERE id IN (${Prisma.join(ids)})
          `,
    ]);
    const bookmarkedIds = new Set(bookmarks.map((b) => b.articleId));
    const likedIds = new Set(likes.map((l) => l.articleId));
    const bodySnippets = new Map(snippetRows.map((r) => [r.id, r.snippet]));

    // canView 恒真(目录公开可读),无需再过滤;toSummary 仍按行计算各自权限。
    return {
      articles: articles.map((a) => toSummary(a, {
        user: { id: user.id, isAdmin: user.isAdmin },
        userRoleIds, bookmarkedIds, likedIds, collaboratorArticleIds, bodySnippets,
      })),
      hasMore,
    };
  });

  // GET /api/articles/:id — single-doc detail.
  app.get<{ Params: { id: string } }>("/api/articles/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const a = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: {
        folder: { include: { role: true } },
        role: true,
        createdBy: { select: { id: true, displayName: true } },
        editingBy: { select: { id: true, displayName: true } },
        inboundRefs: {
          // Hide backlinks whose source doc is in the recycle bin.
          where: { fromArticle: { deletedAt: null } },
          include: { fromArticle: { select: { id: true, title: true, folderId: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } } } },
        },
        _count: { select: { versions: true, likes: true, comments: true, bookmarks: true } },
      },
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
    if (!perms.canView) return reply.code(403).send({ error: "forbidden", message: L(req, "无权访问该文档", "No permission to access this document") });

    // Best-effort PV / 谁看过 tracking — only AFTER the canView gate, so we
    // never stamp a view the user wasn't allowed to read. Fire-and-forget;
    // does not block the response (see recordArticleView).
    recordArticleView(a.id, user.id);

    const [isBookmarked, isLikedRow] = await Promise.all([
      prisma.bookmark.findUnique({ where: { userId_articleId: { userId: user.id, articleId: a.id } } }),
      prisma.like.findUnique({ where: { userId_articleId: { userId: user.id, articleId: a.id } } }),
    ]);

    // Pass the caller's collaborator grants among the REFERENCING (source)
    // docs so a backlink from a doc the caller can only see as a per-article
    // collaborator isn't hidden by the canView filter.
    const inboundCollabIds = await getCollaboratorArticleIds(
      user.id,
      a.inboundRefs.map((r) => r.fromArticle.id),
    );
    const visibleInboundRefs = filterVisibleInboundRefs(
      a.inboundRefs,
      { id: user.id, isAdmin: user.isAdmin },
      userRoleIds,
      inboundCollabIds,
    );

    return {
      article: {
        id: a.id, title: a.title, contentMarkdown: a.contentMarkdown,
        folderId: a.folderId,
        roleId: a.roleId,
        sortOrder: a.sortOrder,
        createdById: a.createdById,
        createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
        permissions: perms,
        createdBy: a.createdBy,
        isBookmarked: !!isBookmarked,
        likeCount: a._count.likes,
        isLiked: !!isLikedRow,
        commentCount: a._count.comments,
        bookmarkCount: a._count.bookmarks,
        // folder is optional now — null for role-direct docs.
        folder: a.folder ? toFolder(a.folder) : null,
        // role is always present (eager-loaded from the article's own
        // roleId, independent of whether it has a folder wrap).
        role: toRole(a.role),
        inboundRefs: visibleInboundRefs,
        versionsCount: a._count.versions,
        // Soft edit-lock state for the detail/edit page. Non-null only
        // while a lock is ACTIVE (fresh heartbeat); lets the FE disable
        // the 编辑 button when editing.userId != the current user.
        editing: isLockActive(a.editingById, a.editingAt)
          ? { userId: a.editingById!, userName: a.editingBy?.displayName ?? null }
          : null,
        // AI 入库前置校验状态。findings 仅对有编辑权限者返回(无编辑权限看不到问题卡)。
        reviewStatus: a.reviewStatus,
        reviewFindings: perms.canEdit && a.reviewFindings ? safeParseFindings(a.reviewFindings) : null,
      },
    };
  });

  // POST /api/articles/:id/edit-lock — acquire OR refresh (heartbeat) the
  // soft edit-lock. Same edit-permission gate as PATCH (admin || author ||
  // collaborator || role-edit). The lock is advisory: while held by someone
  // else the FE disables the 编辑 button, but the server still enforces real
  // permissions on PATCH independently.
  app.post<{ Params: { id: string } }>("/api/articles/:id/edit-lock", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const a = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: {
        folder: true,
        editingBy: { select: { id: true, displayName: true } },
      },
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
    if (!perms.canEdit) return reply.code(403).send({ error: "forbidden", message: L(req, "无权编辑该文档", "No permission to edit this document") });

    // ACTIVE lock held by SOMEONE ELSE → reject. A stale lock (or one held
    // by the caller) is acquirable/refreshable.
    if (isLockActive(a.editingById, a.editingAt) && a.editingById !== user.id) {
      return reply.code(409).send({
        error: "locked",
        message: L(req, "文档正在被他人编辑", "This document is being edited by someone else"),
        lock: { userId: a.editingById!, userName: a.editingBy?.displayName ?? null, mine: false },
      });
    }

    // Raw UPDATE setting ONLY the lock columns. A `prisma.article.update`
    // here would bump `updatedAt` (it's @updatedAt), so every 20s heartbeat
    // would advance the doc's updatedAt and spuriously 409 the editor's next
    // save (it compares expectedUpdatedAt against updatedAt). The lock is
    // metadata about who's editing — it must never count as a document edit.
    const now = new Date();
    await prisma.$executeRaw`
      UPDATE "Article" SET "editingById" = ${user.id}, "editingAt" = ${now}
      WHERE "id" = ${a.id}
    `;
    return {
      lock: { userId: user.id, userName: user.displayName, mine: true, ttlMs: LOCK_TTL_MS },
    };
  });

  // DELETE /api/articles/:id/edit-lock — release the lock. Idempotent:
  // only clears it when the caller currently holds it; releasing a lock you
  // don't hold (or that's already free) is a no-op. Always 204.
  app.delete<{ Params: { id: string } }>("/api/articles/:id/edit-lock", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // Clear only if the caller holds it. Raw UPDATE with the editingById
    // guard makes the release a single conditional write (no read-then-write
    // race, and no 404 surface — the contract is always-204). Like the
    // acquire/heartbeat above this MUST be raw so it doesn't bump the
    // doc's @updatedAt — releasing a lock is not a document edit and must
    // not invalidate a pending save's expectedUpdatedAt.
    await prisma.$executeRaw`
      UPDATE "Article" SET "editingById" = NULL, "editingAt" = NULL
      WHERE "id" = ${req.params.id} AND "editingById" = ${user.id}
    `;
    return reply.code(204).send();
  });

  // 共享:取文章 + 校验编辑权限(review 系列接口复用)。返回 null 表示已 reply 过。
  // 放行条件:对该文档有编辑权(canEdit)。「文档校验」页放开给所有成员后只放开查看,
  // 忽略问题、AI 优化、应用修订仍要求编辑权,避免无关成员抑制他人文档的问题或反复消耗 AI。
  async function loadEditableArticle(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    const id = (req.params as { id: string }).id;
    const a = await prisma.article.findUnique({ where: { id }, include: { folder: true } });
    if (!a || a.deletedAt != null) { reply.code(404).send({ error: "not_found", message: L(req, "文档不存在", "Document not found") }); return null; }
    const userRoleIds = await getUserRoleIds(user.id);
    const mp = getEffectiveFolderPermissions({ user: { id: user.id, isAdmin: user.isAdmin }, userRoleIds, article: { roleId: a.roleId, folder: a.folder } });
    const isCollaborator = await isArticleCollaborator(user.id, a.id);
    const perms = getArticlePermissions({ folderPermissions: mp, article: { createdById: a.createdById }, userId: user.id, isAdmin: user.isAdmin, isCollaborator });
    if (!perms.canEdit) {
      reply.code(403).send({ error: "forbidden", message: L(req, "无权编辑该文档", "No permission to edit this document") });
      return null;
    }
    return { user, article: a, canEdit: perms.canEdit };
  }

  // POST /api/articles/:id/review/dismiss — 忽略当前问题(按 hash 持久抑制)。
  app.post<{ Params: { id: string } }>("/api/articles/:id/review/dismiss", async (req, reply) => {
    const ctx = await loadEditableArticle(req, reply);
    if (!ctx) return;
    const stored = storedHashedFindings(ctx.article.reviewFindings);
    if (stored.length > 0) await addDismissed(ctx.article.id, stored, ctx.user.id);
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus" = 'dismissed', "reviewFindings" = NULL WHERE "id" = ${ctx.article.id}`;
    await clearReviewNotifications(ctx.article.id);
    return { ok: true };
  });

  // POST /api/articles/:id/review/optimize — 让 AI 基于已发现问题产出修订全文(不落库)。
  // SSE 流式:大文档优化可耗时数十秒,同步返回会被网关/CDN idle 超时切断报 504。改为 SSE 后
  // 连接全程活跃(token 帧 + 每 10s 心跳保活),前端可显示进度。契约:
  //   event: token → { text }        增量文本(进度 + 保活)
  //   event: done  → { fixedMarkdown } 最终净化后的修订全文
  //   event: error → { message }      失败/LLM 不可用/被 abort
  // 鉴权/loadEditableArticle/并发锁/断连 abort/findings 为空回原文 等既有行为不变(仅传输层改流式)。
  // 每人每分钟最多 6 次：一次优化会调用 AI 处理整篇文档。
  app.post<{ Params: { id: string } }>("/api/articles/:id/review/optimize", {
    config: {
      rateLimit: {
        max: 6,
        timeWindow: "1 minute",
        keyGenerator: (req: { user?: { id?: string } | null; ip: string }) => req.user?.id ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const ctx = await loadEditableArticle(req, reply);
    if (!ctx) return;
    const findings = storedHashedFindings(ctx.article.reviewFindings);
    // 无问题:回原文。SSE 未开,仍走 JSON(前端 SSE 消费方也识别不到 SSE 才在这里返回;为契约统一,
    // 改为开流 → done(原文) → end,让前端统一从 done 事件取 fixedMarkdown)。
    if (findings.length === 0) {
      const sse = openSse(reply);
      sse.send("done", { fixedMarkdown: ctx.article.contentMarkdown });
      sse.end();
      return;
    }
    if (optimizeInFlight.has(ctx.article.id)) {
      return reply.code(409).send({ error: "busy", message: L(req, "该文档正在优化中,请稍候再试", "This document is being optimized. Try again shortly") });
    }
    optimizeInFlight.add(ctx.article.id);
    // 客户端/网关断连(常见:优化较慢时网关先超时,前端报「请求失败」)→ 中断服务端 LLM 并立即释放
    // in-flight 锁,避免用户再点时被「正在优化中」挡住(此前锁要等服务端自己的 180s 超时才放)。
    const ac = new AbortController();
    const offClose = abortOnClientClose(reply, ac);
    const sse = openSse(reply); // 鉴权/findings 已过,从此走 SSE
    // 心跳:优化期间可能长时间只在最后才吐 token(部分 provider 非流式),每 10s 写一条注释保活,
    // 否则反代 idle 超时会掐断整条流 —— 这正是本次要解决的 504。
    const hb = setInterval(() => sse.comment("alive"), 10_000);
    const t0 = Date.now();
    try {
      // 喂给优化器与复检相同的同角色相关文档,使 consistency/completeness 类修订有据可依、改一次就好。
      const related = await fetchRelatedDocs(ctx.article);
      const bodyChars = ctx.article.contentMarkdown.length;
      const relatedChars = related.reduce((n, r) => n + r.snippet.length, 0);
      // 开始:记录文档规模/问题数/相关文档量。定点补丁模式下 LLM 只产出 edits,输出很小、
      // 与文档大小基本无关,不再随文档变大而线性变慢。
      req.log.info(
        { articleId: ctx.article.id, title: ctx.article.title, bodyChars, findings: findings.length, related: related.length, relatedChars },
        "[articles/optimize] 开始(定点补丁)",
      );
      const diag: ReviewLlmDiag = { log: req.log, label: "optimize" };
      // 不再把 token 逐字转发给前端(输出是补丁 JSON,「已生成 N 字」无意义);心跳注释单独保活,
      // 前端遮罩改用「已用时」计时器。callReviewLlm 内部仍累积完整输出并返回。
      const text = await callReviewLlm(
        OPTIMIZE_SYSTEM,
        buildOptimizeUserMessage({ title: ctx.article.title, body: ctx.article.contentMarkdown }, findings, related),
        ac.signal,
        undefined,
        diag,
      );
      const elapsedMs = Date.now() - t0;
      if (!text) {
        // 据 callReviewLlm 回写的 reason 给出有区分度的提示 + 定位日志(不再统一「暂不可用」)。
        req.log.warn({ articleId: ctx.article.id, reason: diag.reason, elapsedMs, bodyChars }, "[articles/optimize] 无结果");
        const message =
          diag.reason === "timeout" ? L(req, "AI 优化超时,请稍后再试", "AI optimization timed out. Try again later") :
          diag.reason === "semaphore_busy" ? L(req, "AI 正忙,请稍后再试", "AI is busy. Try again later") :
          diag.reason === "client_abort" ? L(req, "优化已取消", "Optimization canceled") :
          diag.reason === "empty_output" ? L(req, "AI 未返回有效结果,请稍后再试", "AI returned no valid result. Try again later") :
          L(req, "AI 优化暂不可用,请稍后再试", "AI optimization is unavailable. Try again later");
        sse.send("error", { message });
      } else {
        // 定点补丁:解析 edits → 应用到原文得到修订全文。全部 edit 都无法定位(applied=0)则视为失败。
        const edits = parseOptimizeEdits(text);
        const { markdown, applied, failed } = applyOptimizeEdits(ctx.article.contentMarkdown, edits);
        req.log.info(
          { articleId: ctx.article.id, elapsedMs, outChars: text.length, edits: edits.length, applied, failed: failed.length, failReasons: failed.map((f) => f.reason) },
          "[articles/optimize] 完成(补丁应用)",
        );
        if (applied === 0) {
          sse.send("error", { message: edits.length === 0 ? L(req, "AI 未提出可应用的修改,请稍后再试", "AI proposed no applicable changes. Try again later") : L(req, "AI 未能定位到问题原文,请稍后再试", "AI could not locate the problem text. Try again later") });
        } else {
          // unlocated = 未能定位/应用的补丁数:部分成功时前端据此提示「还有 N 处未自动定位」,
          // 避免用户误以为所有问题都已修复。
          sse.send("done", { fixedMarkdown: markdown, unlocated: failed.length });
        }
      }
    } catch (e) {
      req.log.error({ err: e, articleId: ctx.article.id, elapsedMs: Date.now() - t0 }, "[articles/optimize] failed");
      sse.send("error", { message: L(req, "AI 优化失败,请稍后再试", "AI optimization failed. Try again later") });
    } finally {
      clearInterval(hb);
      offClose();
      optimizeInFlight.delete(ctx.article.id);
      sse.end();
    }
  });

  // POST /api/articles/:id/review/apply — 应用 AI 修订:存原文为 ai-fix 版本 → 写入修订
  // 正文(并把 review 置 pending、清问题)→ 绑定上传 → 异步复检(fire-and-forget,不阻塞)。
  app.post<{ Params: { id: string }; Body: { contentMarkdown?: unknown; expectedUpdatedAt?: unknown } }>("/api/articles/:id/review/apply", async (req, reply) => {
    const ctx = await loadEditableArticle(req, reply);
    if (!ctx) return;
    const body = req.body as { contentMarkdown?: unknown; expectedUpdatedAt?: unknown };
    const newBody = typeof body.contentMarkdown === "string" ? body.contentMarkdown : null;
    if (!newBody || !newBody.trim()) return reply.code(400).send({ error: "invalid_input", message: L(req, "缺少修订内容", "Missing revised content") });
    if (newBody === ctx.article.contentMarkdown) return reply.code(400).send({ error: "no_change", message: L(req, "内容未变化", "Content unchanged") });
    // 乐观锁:optimize→看 diff→apply 间隔可达数十秒,期间他人可能保存。带了 expectedUpdatedAt
    // 且与当前不符 → 409,避免覆盖他人编辑(与 PATCH 同款保护)。
    if (typeof body.expectedUpdatedAt === "string" && ctx.article.updatedAt.toISOString() !== body.expectedUpdatedAt) {
      return reply.code(409).send({ error: "conflict", message: L(req, "文档已被修改，请刷新后再应用", "The document was modified. Refresh and apply again"), serverUpdatedAt: ctx.article.updatedAt.toISOString() });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.articleVersion.create({
        data: { articleId: ctx.article.id, title: ctx.article.title, contentMarkdown: ctx.article.contentMarkdown, kind: "ai-fix", authorId: ctx.user.id },
      });
      // 一键优化即「标记已优化」:直接置 ok、清空问题(徽标立即消失),并把校验基线
      // (reviewedHash)对齐到优化后的内容。【不再立即复检】—— 信任本次优化结果;但其后
      // 用户对文档的【任何改动】(哪怕一个字)都会触发重新校验。
      const u = await tx.article.update({
        where: { id: ctx.article.id },
        data: {
          contentMarkdown: newBody,
          reviewStatus: "ok",
          reviewFindings: null,
          reviewedHash: contentHash(ctx.article.title, newBody),
        },
      });
      // 把 reviewedAt 对齐到本次刚 bump 的 updatedAt(同值),使扫描器的 SQL 谓词
      // 「reviewedAt < updatedAt」直接把本篇排除在候选之外 —— 不再依赖「逐字节 hash 相等」
      // 在 JS 里兜底跳过(那样本篇仍会每轮占用扫描窗口)。raw 写不再 bump updatedAt。
      await tx.$executeRaw`UPDATE "Article" SET "reviewedAt" = ${u.updatedAt.getTime()} WHERE "id" = ${ctx.article.id}`;
      await syncArticleLinks(tx, ctx.article.id, newBody);
      return u;
    });
    markRoleSkillStale(ctx.article.roleId);
    // 问题已视为解决:清掉该文档残留的「待优化」站内/飞书通知。
    await clearReviewNotifications(ctx.article.id);
    return { reviewStatus: "ok", reviewFindings: null, updatedAt: updated.updatedAt.toISOString() };
  });

  // POST /api/articles — create a doc.
  // `roleId` is required. `folderId` is optional: omit/null = the doc
  // hangs directly under the role; provide a folderId = the doc goes
  // inside that folder.
  app.post("/api/articles", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = articleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { roleId, folderId: inputFolderId, contentMarkdown } = parsed.data;
    const title = normalizeTitle(parsed.data.title, requestLang(req));

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) return reply.code(404).send({ error: "not_found", message: L(req, "角色不存在", "Role not found") });

    let foldRecord: { id: string; roleId: string; visibility: string } | null = null;
    if (inputFolderId) {
      const fold = await prisma.folder.findUnique({ where: { id: inputFolderId } });
      if (!fold || fold.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "目录不存在", "Folder not found") });
      if (fold.roleId !== roleId) {
        return reply.code(400).send({ error: "invalid_input", message: L(req, "目录不属于指定角色", "The folder does not belong to the specified role") });
      }
      foldRecord = fold;
    }

    const userRoleIds = await getUserRoleIds(user.id);
    // Permission: must be role member or admin (writing under a role).
    // Folder visibility doesn't affect create permission — role
    // membership is the gate.
    const canCreate = user.isAdmin || userRoleIds.has(roleId);
    if (!canCreate) return reply.code(403).send({ error: "forbidden", message: L(req, "无权在该角色下创建文档", "No permission to create documents under this role") });

    // Next sortOrder = (current max in target sibling group) + 1.
    const sortAgg = await prisma.article.aggregate({
      where: inputFolderId ? { folderId: inputFolderId } : { folderId: null, roleId },
      _max: { sortOrder: true },
    });
    const nextSort = (sortAgg._max.sortOrder ?? 0) + 1;

    // Create + bind embedded uploads in ONE transaction. Binding outside
    // the create commit left a window where the freshly-created doc's
    // `/uploads/...` images were unanchored — an orphan-reaper running in
    // that gap could reap them. Anchoring atomically with the create closes
    // it (mirrors the PATCH path's tx + bindUploadsToArticle(tx, ...)).
    const newArticleId = await uniqueArticleId();
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.article.create({
        data: {
          id: newArticleId,
          title,
          contentMarkdown,
          roleId,
          folderId: inputFolderId ?? null,
          sortOrder: nextSort,
          createdById: user.id,
        },
        include: {
          folder: { include: { role: true } },
          role: true,
          createdBy: { select: { id: true, displayName: true } },
        },
      });
      await syncArticleLinks(tx, c.id, contentMarkdown);
      return c;
    });
    markRoleSkillStale(roleId);

    // Compute response permissions
    const mp = foldRecord
      ? getFolderPermissions({ user: { id: user.id, isAdmin: user.isAdmin }, userRoleIds, folder: { roleId: foldRecord.roleId, visibility: asFolderVisibility(foldRecord.visibility) } })
      : getRoleDirectPermissions({ user: { id: user.id, isAdmin: user.isAdmin }, userRoleIds, roleId });
    const perms = getArticlePermissions({
      folderPermissions: mp,
      article: { createdById: created.createdById },
      userId: user.id,
      isAdmin: user.isAdmin,
    });
    reply.code(201);
    return {
      article: {
        id: created.id, title: created.title, contentMarkdown: created.contentMarkdown,
        folderId: created.folderId,
        roleId: created.roleId,
        sortOrder: created.sortOrder,
        createdById: created.createdById,
        createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString(),
        permissions: perms,
        createdBy: created.createdBy,
        isBookmarked: false,
        likeCount: 0,
        isLiked: false,
        commentCount: 0,
        bookmarkCount: 0,
        folder: created.folder ? toFolder(created.folder) : null,
        role: toRole(created.role),
        inboundRefs: [],
        versionsCount: 0,
      },
    };
  });

  // PATCH /api/articles/:id — edit content / status.
  app.patch<{ Params: { id: string } }>("/api/articles/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = articleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const data = parsed.data;

    const existing = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: { folder: true, role: true },
    });
    if (!existing || existing.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "文档不存在", "Document not found") });

    const userRoleIds = await getUserRoleIds(user.id);
    const mp = getEffectiveFolderPermissions({
      user: { id: user.id, isAdmin: user.isAdmin },
      userRoleIds,
      article: { roleId: existing.roleId, folder: existing.folder },
    });
    // 去状态后:不再有「归档冻结」与发布/归档流转。任何有编辑权限的人都可以
    // 直接改任意文档(含历史上 status 列为 archived 的数据)。
    const isCollaborator = await isArticleCollaborator(user.id, existing.id);
    const existingPerms = getArticlePermissions({
      folderPermissions: mp,
      article: { createdById: existing.createdById },
      userId: user.id,
      isAdmin: user.isAdmin,
      isCollaborator,
    });
    if (!existingPerms.canEdit) return reply.code(403).send({ error: "forbidden", message: L(req, "无权编辑该文档", "No permission to edit this document") });

    if (data.expectedUpdatedAt !== undefined && existing.updatedAt.toISOString() !== data.expectedUpdatedAt) {
      return reply.code(409).send({
        error: "conflict",
        message: L(req, "另一处会话已修改了这篇文档，请刷新后再保存", "Another session modified this document. Refresh before saving"),
        serverUpdatedAt: existing.updatedAt.toISOString(),
      });
    }

    // Rename to "未命名文档" when the caller explicitly clears the
    // title (sends ""). `undefined` means "untouched" and keeps the
    // existing value — don't conflate the two.
    const newTitle = data.title !== undefined ? normalizeTitle(data.title, requestLang(req)) : existing.title;
    const newBody = data.contentMarkdown ?? existing.contentMarkdown;

    // 去状态后:不再有发布/归档流转,版本一律记为普通编辑(kind="edit")。
    const skipVersion =
      newTitle === existing.title &&
      newBody === existing.contentMarkdown;

    // 乐观锁必须和写入是同一条带条件的 UPDATE：上面的预检查和事务之间有多个 await，
    // 两个携带同一 expectedUpdatedAt 的并发请求都能通过预检查。这里用 updatedAt 作条件，
    // 先到的把 updatedAt 改掉，后到的匹配不到行(count=0)，整个事务回滚并返回 409。
    class SaveConflict extends Error {}
    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        if (data.expectedUpdatedAt !== undefined) {
          const guard = await tx.article.updateMany({
            where: { id: existing.id, updatedAt: new Date(data.expectedUpdatedAt) },
            data: { title: newTitle, contentMarkdown: newBody },
          });
          if (guard.count === 0) throw new SaveConflict();
        }
        if (!skipVersion) await tx.articleVersion.create({
          data: {
            articleId: existing.id,
            title: newTitle,
            contentMarkdown: newBody,
            kind: "edit",
            authorId: user.id,
          },
        });

        const updatedArticle = await tx.article.update({
          where: { id: existing.id },
          data: { title: newTitle, contentMarkdown: newBody },
          include: {
            folder: { include: { role: true } },
            role: true,
            createdBy: { select: { id: true, displayName: true } },
            inboundRefs: {
              // Hide backlinks whose source doc is in the recycle bin.
              where: { fromArticle: { deletedAt: null } },
              include: { fromArticle: { select: { id: true, title: true, folderId: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } } } },
            },
            _count: { select: { versions: true, likes: true, comments: true, bookmarks: true } },
          },
        });

        await syncArticleLinks(tx, existing.id, newBody);

        return updatedArticle;
      });
    } catch (e) {
      if (!(e instanceof SaveConflict)) throw e;
      const latest = await prisma.article.findUnique({ where: { id: existing.id }, select: { updatedAt: true } });
      return reply.code(409).send({
        error: "conflict",
        message: L(req, "另一处会话已修改了这篇文档，请刷新后再保存", "Another session modified this document. Refresh before saving"),
        serverUpdatedAt: latest?.updatedAt.toISOString(),
      });
    }

    // 去状态后:技能源改为按正文长度纳入(见 hasRetrievableContent),任何内容/标题
    // 变更都可能影响角色技能,故只要写了新版本就标记技能 stale。
    if (!skipVersion) markRoleSkillStale(existing.roleId);

    const [isBookmarked, isLikedRow] = await Promise.all([
      prisma.bookmark.findUnique({ where: { userId_articleId: { userId: user.id, articleId: existing.id } } }),
      prisma.like.findUnique({ where: { userId_articleId: { userId: user.id, articleId: existing.id } } }),
    ]);

    const perms = getArticlePermissions({
      folderPermissions: mp,
      article: { createdById: updated.createdById },
      userId: user.id,
      isAdmin: user.isAdmin,
      isCollaborator,
    });
    const inboundCollabIdsPatch = await getCollaboratorArticleIds(
      user.id,
      updated.inboundRefs.map((r) => r.fromArticle.id),
    );
    const visibleInboundRefsPatch = filterVisibleInboundRefs(
      updated.inboundRefs,
      { id: user.id, isAdmin: user.isAdmin },
      userRoleIds,
      inboundCollabIdsPatch,
    );
    return {
      article: {
        id: updated.id, title: updated.title, contentMarkdown: updated.contentMarkdown,

        folderId: updated.folderId,
        roleId: updated.roleId,
        sortOrder: updated.sortOrder,
        createdById: updated.createdById,
        createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString(),
        permissions: perms,
        createdBy: updated.createdBy,
        isBookmarked: !!isBookmarked,
        likeCount: updated._count.likes,
        isLiked: !!isLikedRow,
        commentCount: updated._count.comments,
        bookmarkCount: updated._count.bookmarks,
        folder: updated.folder ? toFolder(updated.folder) : null,
        role: toRole(updated.role),
        inboundRefs: visibleInboundRefsPatch,
        versionsCount: updated._count.versions,
      },
    };
  });

  // DELETE /api/articles/:id — author + admin only. Soft-delete:
  // moves the doc into the deleter's recycle bin (deletedAt/deletedById
  // set) rather than hard-deleting. Permanent removal happens from the
  // bin (DELETE /api/recycle-bin/article/:id).
  app.delete<{ Params: { id: string } }>("/api/articles/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const a = await prisma.article.findUnique({ where: { id: req.params.id } });
    // Already-binned docs read as not-found to the normal API surface.
    if (!a || a.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "文档不存在", "Document not found") });

    const isAuthor = a.createdById === user.id;
    if (!user.isAdmin && !isAuthor) {
      return reply.code(403).send({ error: "forbidden", message: L(req, "无权删除该文档", "No permission to delete this document") });
    }

    await prisma.article.update({
      where: { id: a.id },
      data: { deletedAt: new Date(), deletedById: user.id },
    });
    markRoleSkillStale(a.roleId);
    return reply.code(204).send();
  });

  // POST /api/articles/bulk — 批量删除(去状态后仅余删除动作),作者 + 管理员。
  app.post("/api/articles/bulk", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = articleBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { action, ids } = parsed.data;

    const ok: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    const articles = await prisma.article.findMany({ where: { id: { in: ids }, deletedAt: null } });
    const byId = new Map(articles.map((a) => [a.id, a]));

    // Soft-delete into the deleter's recycle bin. Authorize per-id (same
    // author/admin gate as the single-doc DELETE), then bin the authorized
    // ids in ONE updateMany. All authorized rows share one deletedAt instant.
    const authorizedIds: string[] = [];
    for (const id of ids) {
      const a = byId.get(id);
      if (!a) { failed.push({ id, reason: "not_found" }); continue; }
      const isAuthor = a.createdById === user.id;
      if (!user.isAdmin && !isAuthor) { failed.push({ id, reason: "forbidden" }); continue; }
      authorizedIds.push(id);
    }
    if (authorizedIds.length > 0) {
      try {
        await prisma.article.updateMany({
          where: { id: { in: authorizedIds }, deletedAt: null },
          data: { deletedAt: new Date(), deletedById: user.id },
        });
        ok.push(...authorizedIds);
        // 删除可能影响角色技能(技能源按正文长度纳入)→ 标记相关角色 stale。
        const roles = new Set(
          authorizedIds.map((id) => byId.get(id)?.roleId).filter((r): r is string => !!r),
        );
        for (const rid of roles) markRoleSkillStale(rid);
      } catch (err) {
        req.log.error({ err, ids: authorizedIds, action }, "bulk delete failed");
        for (const id of authorizedIds) failed.push({ id, reason: "internal_error" });
      }
    }
    return { ok, failed };
  });

  // GET /api/articles/:id/versions — version history.
  app.get<{ Params: { id: string }; Querystring: { take?: string; cursor?: string } }>(
    "/api/articles/:id/versions",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const a = await prisma.article.findUnique({
        where: { id: req.params.id },
        include: { folder: true, role: true },
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
      if (!perms.canView) return reply.code(403).send({ error: "forbidden", message: L(req, "无权访问该文档", "No permission to access this document") });

      const take = Math.min(Math.max(Number(req.query.take) || 20, 1), 100);
      const cursorId = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      const rows = await prisma.articleVersion.findMany({
        where: { articleId: a.id },
        orderBy: { createdAt: "desc" },
        take: take + 1,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        include: { author: { select: { displayName: true } } },
      });

      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;
      const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

      return {
        versions: page.map((v) => ({
          id: v.id,
          articleId: v.articleId,
          title: v.title,
          contentMarkdown: v.contentMarkdown,

          authorId: v.authorId,
          authorDisplayName: v.author?.displayName ?? null,
          createdAt: v.createdAt.toISOString(),
        })),
        nextCursor,
      };
    },
  );

  // POST /api/articles/:id/versions/:versionId/restore — revert the
  // article's title + body to a historical version. Same permission as
  // editing (canEdit); archived docs are immutable (400, like other
  // edits). Goes through the SAME version-snapshot path the normal PATCH
  // uses, so the PRE-restore state is captured into history before the
  // revert. Status is NOT changed (the doc keeps its current status).
  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/articles/:id/versions/:versionId/restore",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;

      const existing = await prisma.article.findUnique({
        where: { id: req.params.id },
        include: { folder: true, role: true },
      });
      if (!existing || existing.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "文档不存在", "Document not found") });

      const userRoleIds = await getUserRoleIds(user.id);
      const mp = getEffectiveFolderPermissions({
        user: { id: user.id, isAdmin: user.isAdmin },
        userRoleIds,
        article: { roleId: existing.roleId, folder: existing.folder },
      });
      const isCollaborator = await isArticleCollaborator(user.id, existing.id);
      const existingPerms = getArticlePermissions({
        folderPermissions: mp,
        article: { createdById: existing.createdById },
        userId: user.id,
        isAdmin: user.isAdmin,
        isCollaborator,
      });
      if (!existingPerms.canEdit) return reply.code(403).send({ error: "forbidden", message: L(req, "无权编辑该文档", "No permission to edit this document") });

      // The version must belong to THIS article — a versionId from another
      // doc reads as not-found so callers can't probe across documents.
      const version = await prisma.articleVersion.findFirst({
        where: { id: req.params.versionId, articleId: existing.id },
      });
      if (!version) return reply.code(404).send({ error: "not_found", message: L(req, "历史版本不存在", "Version not found") });

      // Restore = set title + body to the version's values, keeping the
      // current status. Snapshot the PRE-restore state into history first
      // (same path as PATCH) so the revert itself is undoable. A no-op
      // restore (already identical) skips the snapshot to avoid clutter.
      const newTitle = version.title;
      const newBody = version.contentMarkdown;
      const skipVersion =
        newTitle === existing.title && newBody === existing.contentMarkdown;
      const updated = await prisma.$transaction(async (tx) => {
        if (!skipVersion) await tx.articleVersion.create({
          data: {
            articleId: existing.id,
            title: existing.title,
            contentMarkdown: existing.contentMarkdown,
            // This snapshot is created by the restore action itself → tag it so
            // the activity feed shows 回滚版本 (not 编辑文档).
            kind: "restore",
            authorId: user.id,
          },
        });

        const updatedArticle = await tx.article.update({
          where: { id: existing.id },
          data: { title: newTitle, contentMarkdown: newBody },
          include: {
            folder: { include: { role: true } },
            role: true,
            createdBy: { select: { id: true, displayName: true } },
            inboundRefs: {
              where: { fromArticle: { deletedAt: null } },
              include: { fromArticle: { select: { id: true, title: true, folderId: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } } } },
            },
            _count: { select: { versions: true, likes: true, comments: true, bookmarks: true } },
          },
        });

        await syncArticleLinks(tx, existing.id, newBody);

        return updatedArticle;
      });

      // Reverting a PUBLISHED doc to an older revision changes the skill's source.
      if (!skipVersion) markRoleSkillStale(updated.roleId);

      const [isBookmarked, isLikedRow] = await Promise.all([
        prisma.bookmark.findUnique({ where: { userId_articleId: { userId: user.id, articleId: existing.id } } }),
        prisma.like.findUnique({ where: { userId_articleId: { userId: user.id, articleId: existing.id } } }),
      ]);

      const perms = getArticlePermissions({
        folderPermissions: mp,
        article: { createdById: updated.createdById },
        userId: user.id,
        isAdmin: user.isAdmin,
        isCollaborator,
      });
      const inboundCollabIds = await getCollaboratorArticleIds(
        user.id,
        updated.inboundRefs.map((r) => r.fromArticle.id),
      );
      const visibleInboundRefs = filterVisibleInboundRefs(
        updated.inboundRefs,
        { id: user.id, isAdmin: user.isAdmin },
        userRoleIds,
        inboundCollabIds,
      );
      return {
        article: {
          id: updated.id, title: updated.title, contentMarkdown: updated.contentMarkdown,
  
          folderId: updated.folderId,
          roleId: updated.roleId,
          sortOrder: updated.sortOrder,
          createdById: updated.createdById,
          createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString(),
          permissions: perms,
          createdBy: updated.createdBy,
          isBookmarked: !!isBookmarked,
          likeCount: updated._count.likes,
          isLiked: !!isLikedRow,
          commentCount: updated._count.comments,
          bookmarkCount: updated._count.bookmarks,
          folder: updated.folder ? toFolder(updated.folder) : null,
          role: toRole(updated.role),
          inboundRefs: visibleInboundRefs,
          versionsCount: updated._count.versions,
        },
      };
    },
  );

  // GET /api/articles/:id/views — PV / 独立访客 / 谁看过 for the doc-detail
  // dialog. Gated by canView. `canSeeViewers` (author / admin / collaborator)
  // decides whether the per-viewer list is returned — non-privileged
  // viewers get the aggregate counts only (`viewers: null`).
  app.get<{ Params: { id: string } }>("/api/articles/:id/views", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const a = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: { folder: true, role: true },
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
    if (!perms.canView) return reply.code(403).send({ error: "forbidden", message: L(req, "无权访问该文档", "No permission to access this document") });

    // Only the author, an admin, or a per-article collaborator may see WHO
    // viewed the doc; everyone else sees aggregate counts only. This keeps
    // the reader list to people with an editorial stake in the doc.
    const canSeeViewers = a.createdById === user.id || user.isAdmin || isCollaborator;

    // PV = SUM(viewCount), 独立访客 = COUNT(rows). Compute both in the DB via
    // aggregate instead of loading every ArticleView row and reducing in JS —
    // a popular doc could have thousands of viewer rows, and a non-privileged
    // viewer (who only sees the aggregate) never needs the rows at all.
    const agg = await prisma.articleView.aggregate({
      where: { articleId: a.id },
      _sum: { viewCount: true },
      _count: { _all: true },
    });
    const pv = agg._sum.viewCount ?? 0;
    const uniqueViewers = agg._count._all;

    // Only load the per-viewer rows when the caller is allowed to see them.
    const rows = canSeeViewers
      ? await prisma.articleView.findMany({
          where: { articleId: a.id },
          orderBy: { lastViewedAt: "desc" },
          include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
        })
      : [];

    return {
      pv,
      uniqueViewers,
      canSeeViewers,
      viewers: canSeeViewers
        ? rows.map((r) => ({
            user: { id: r.user.id, displayName: r.user.displayName, avatarUrl: r.user.avatarUrl },
            lastViewedAt: r.lastViewedAt.toISOString(),
            viewCount: r.viewCount,
          }))
        : null,
    };
  });

  // GET /api/articles/search — by title, citation-permission filtered.
  app.get<{ Querystring: { q?: string } }>("/api/articles/search", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = articleSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { q } = parsed.data;

    const userRoleIds = await getUserRoleIds(user.id);

    // Permission filtering happens AFTER the DB query, so a naive
    // `take: N` followed by a citability filter can return an
    // under-filled page when many of the top rows aren't citable while
    // citable matches sit deeper. Over-fetch in bounded cursor pages and
    // keep filtering until we've collected a full page (PAGE_SIZE) or the
    // title-match source is exhausted. The MAX_SCAN cap keeps this from
    // degrading into a full-table scan on a pathological query.
    const PAGE_SIZE = 10;
    const BATCH = 50;
    const MAX_SCAN = 500;

    type SearchCandidate = Prisma.ArticleGetPayload<{
      include: { folder: { include: { role: true } }; role: true; createdBy: { select: { displayName: true } } };
    }>;
    const visible: SearchCandidate[] = [];
    let cursorId: string | undefined;
    let scanned = 0;

    while (visible.length < PAGE_SIZE && scanned < MAX_SCAN) {
      const candidates = await prisma.article.findMany({
        where: { title: { contains: q }, deletedAt: null },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: BATCH,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        include: { folder: { include: { role: true } }, role: true, createdBy: { select: { displayName: true } } },
      });
      if (candidates.length === 0) break;
      scanned += candidates.length;
      cursorId = candidates[candidates.length - 1]?.id;

      const collabIds = await getCollaboratorArticleIds(user.id, candidates.map((a) => a.id));
      for (const a of candidates) {
        const mp = getEffectiveFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          article: { roleId: a.roleId, folder: a.folder },
        });
        const perms = getArticlePermissions({
          folderPermissions: mp,
          article: { createdById: a.createdById },
          userId: user.id,
          isAdmin: user.isAdmin,
          isCollaborator: collabIds.has(a.id),
        });
        if (perms.canCite) {
          visible.push(a);
          if (visible.length >= PAGE_SIZE) break;
        }
      }
      // The source is exhausted once a batch came back short of BATCH.
      if (candidates.length < BATCH) break;
    }

    const editorMap = await editorNamesByArticle(visible.map((a) => a.id));
    return {
      hits: visible.map((a) => ({
        id: a.id,
        title: a.title,
        folderId: a.folderId,
        folderName: a.folder?.name ?? null,
        roleId: a.roleId,
        roleName: a.role.name,
        roleColor: a.role.color,
        updatedAt: a.updatedAt.toISOString(),
        editorName: editorMap.get(a.id) ?? a.createdBy?.displayName ?? null,
      })),
    };
  });

  // GET /api/articles/recent-views — 当前用户最近打开过的文档(顶栏搜索弹窗空态)。
  // 复用 ArticleView:取本人浏览行按 lastViewedAt 倒序,排除已删,权限过滤后补足到
  // take。权限判定同列表/搜索:用 canView(能打开就算最近浏览)。
  // 取舍:这里是单次 bounded 取 MAX_SCAN 行在内存里过滤(不像 search 那样游标续取)。
  // 若 top-MAX_SCAN 浏览行里多数已无权限/被删,可能凑不满 take —— 但最近的浏览始终在
  // 扫描窗口顶部,故只影响「补满」而非「正确性」(永不返回错文档),对这个空态小部件
  // 可接受。如需与 search 完全一致的补满,可改成按 lastViewedAt/articleId 游标续取。
  app.get<{ Querystring: { take?: string } }>("/api/articles/recent-views", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const take = Math.min(20, Math.max(1, Number(req.query.take) || 8));
    const MAX_SCAN = 200;

    const userRoleIds = await getUserRoleIds(user.id);
    const rows = await prisma.articleView.findMany({
      where: { userId: user.id, article: { deletedAt: null } },
      orderBy: { lastViewedAt: "desc" },
      take: MAX_SCAN,
      include: {
        article: {
          include: { folder: { include: { role: true } }, role: true, createdBy: { select: { displayName: true } } },
        },
      },
    });

    type RecentRow = (typeof rows)[number];
    const visible: RecentRow[] = [];
    const collabIds = await getCollaboratorArticleIds(user.id, rows.map((r) => r.articleId));
    for (const r of rows) {
      const a = r.article;
      const mp = getEffectiveFolderPermissions({
        user: { id: user.id, isAdmin: user.isAdmin },
        userRoleIds,
        article: { roleId: a.roleId, folder: a.folder },
      });
      const perms = getArticlePermissions({
        folderPermissions: mp,
        article: { createdById: a.createdById },
        userId: user.id,
        isAdmin: user.isAdmin,
        isCollaborator: collabIds.has(a.id),
      });
      if (perms.canView) {
        visible.push(r);
        if (visible.length >= take) break;
      }
    }

    const editorMap = await editorNamesByArticle(visible.map((r) => r.articleId));
    return {
      hits: visible.map((r) => ({
        id: r.article.id,
        title: r.article.title,
        folderId: r.article.folderId,
        folderName: r.article.folder?.name ?? null,
        roleId: r.article.roleId,
        roleName: r.article.role.name,
        roleColor: r.article.role.color,
        lastViewedAt: r.lastViewedAt.toISOString(),
        updatedAt: r.article.updatedAt.toISOString(),
        editorName: editorMap.get(r.articleId) ?? r.article.createdBy?.displayName ?? null,
      })),
    };
  });

  // GET /api/articles/:id/export — markdown or zip bundle.
  app.get<{ Params: { id: string } }>("/api/articles/:id/export", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const a = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: {
        folder: { include: { role: true } },
        role: true,
        createdBy: { select: { displayName: true } },
      },
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
    if (!perms.canExport) return reply.code(403).send({ error: "forbidden", message: L(req, "无权导出该文档", "No permission to export this document") });

    const bundle = await buildArticleExport(prisma, a);
    reply
      .header("Content-Type", bundle.contentType)
      .header(
        "Content-Disposition",
        // RFC 5987:filename*= 让非 ASCII 标题在各浏览器下都能还原成原名;保留 filename= 作兜底。
        `attachment; filename="${encodeURIComponent(bundle.filename)}"; filename*=UTF-8''${encodeURIComponent(bundle.filename)}`,
      );
    return reply.send(bundle.body);
  });

  // PATCH /api/articles/:id/move — change parent (folder or role-direct).
  // Body: { targetFolderId: string | null }. Author + admin only.
  app.patch<{ Params: { id: string } }>("/api/articles/:id/move", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = articleMoveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { targetFolderId } = parsed.data;

    const a = await prisma.article.findUnique({ where: { id: req.params.id } });
    if (!a || a.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "文档不存在", "Document not found") });

    // Reorganizing a role's folders is an edit on that role's content, so
    // gate it the SAME way as create + reorder: admin, OR a current member
    // of the doc's role. Author alone is NOT enough — an author removed from
    // the role must not keep moving that role's docs around. (canEdit on the
    // doc itself isn't sufficient either: a per-article collaborator can edit
    // the body but shouldn't restructure the role's folder tree.)
    const userRoleIds = await getUserRoleIds(user.id);
    const canMove = user.isAdmin || userRoleIds.has(a.roleId);
    if (!canMove) {
      return reply.code(403).send({ error: "forbidden", message: L(req, "无权移动该文档", "No permission to move this document") });
    }

    if (targetFolderId) {
      const folder = await prisma.folder.findUnique({ where: { id: targetFolderId } });
      if (!folder || folder.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "目标目录不存在", "Target folder not found") });
      if (folder.roleId !== a.roleId) {
        return reply.code(400).send({ error: "invalid_input", message: L(req, "目标目录与文档不在同一角色下", "The target folder and the document are not under the same role") });
      }
    }

    // Push to the end of the new sibling group's sortOrder.
    const sortAgg = await prisma.article.aggregate({
      where: targetFolderId ? { folderId: targetFolderId } : { folderId: null, roleId: a.roleId },
      _max: { sortOrder: true },
    });
    const nextSort = (sortAgg._max.sortOrder ?? 0) + 1;

    const updated = await prisma.article.update({
      where: { id: a.id },
      data: { folderId: targetFolderId, sortOrder: nextSort },
      select: { id: true, folderId: true, sortOrder: true },
    });
    return { article: updated };
  });

  // POST /api/articles/import — create a doc by uploading a .md
  // file. Multipart upload; metadata (roleId, folderId, title) is
  // carried in form fields alongside the file.
  // The dialog lets the user edit the title before commit, so the
  // submitted title is taken verbatim. File is parsed as UTF-8 markdown.
  // Size cap: 20MB (matches the body cap for article content).
  //
  // Field ordering: @fastify/multipart's req.file() only exposes fields
  // that arrived *before* the file part in the wire stream. Using
  // req.parts() instead lets us collect all fields regardless of order —
  // this is the correct fix (not just a 400 guard) because it makes the
  // server robust to any legal multipart ordering.
  app.post("/api/articles/import", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // Collect all parts in order; fields can appear before or after the file.
    const collectedFields: Record<string, string> = {};
    let fileFilename: string | null = null;
    let fileBuffer: Buffer | null = null;

    try {
      for await (const part of req.parts({ limits: { fileSize: 20 * 1024 * 1024 } })) {
        if (part.type === "field") {
          collectedFields[part.fieldname] = String(part.value);
        } else {
          // file part — only accept the first file named "file"
          fileFilename = part.filename ?? "";
          fileBuffer = await part.toBuffer();
        }
      }
    } catch {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "请上传 .md 文件", "Upload a .md file") });
    }
    if (!fileBuffer || fileFilename === null) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "请上传 .md 文件", "Upload a .md file") });
    }

    const roleId = collectedFields.roleId?.trim();
    const folderIdRaw = collectedFields.folderId?.trim();
    const folderId = folderIdRaw && folderIdRaw !== "null" ? folderIdRaw : null;
    const title = collectedFields.title?.trim();

    if (!roleId || !title) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "缺少 roleId 或 title", "Missing roleId or title") });
    }
    if (title.length > 255) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "标题过长", "Title too long") });
    }

    // Extension check — only .md (the file picker should narrow this
    // client-side, but server-side enforce the contract).
    const filename = fileFilename;
    if (!/\.md$/i.test(filename)) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "仅支持 .md 文件", "Only .md files are supported") });
    }

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) return reply.code(404).send({ error: "not_found", message: L(req, "角色不存在", "Role not found") });

    let foldRecord: { id: string; roleId: string } | null = null;
    if (folderId) {
      const fold = await prisma.folder.findUnique({ where: { id: folderId } });
      if (!fold || fold.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "目录不存在", "Folder not found") });
      if (fold.roleId !== roleId) {
        return reply.code(400).send({ error: "invalid_input", message: L(req, "目录不属于指定角色", "The folder does not belong to the specified role") });
      }
      foldRecord = fold;
    }

    const userRoleIds = await getUserRoleIds(user.id);
    const canCreate = user.isAdmin || userRoleIds.has(roleId);
    if (!canCreate) return reply.code(403).send({ error: "forbidden", message: L(req, "无权在该角色下创建文档", "No permission to create documents under this role") });

    // Buffer was already collected in the parts loop above (fileSize cap enforced there).
    const contentMarkdown = fileBuffer.toString("utf8");
    if (contentMarkdown.length > 20_000_000) {
      return reply.code(413).send({ error: "payload_too_large", message: L(req, "文档内容超过 20MB 上限", "Document content exceeds the 20MB limit") });
    }

    // 同名冲突:判定范围 = 同一容器(同角色 + 同目录,role-direct 即 folderId
    // null),排除回收站(deletedAt != null)。onConflict 决定行为:
    //   未指定    → 409,前端弹窗让用户选(覆盖 / 改名 / 取消);
    //   "overwrite" → 覆盖该文档:导入前的内容先存历史版本(kind=import,可回滚),
    //                 正文替换为导入内容;
    //   "rename"    → 自动取未占用的「标题 (n)」作为新文档导入。
    // 同容器若有多个同名(历史遗留允许重名),取最近更新的那个覆盖。
    const onConflict = collectedFields.onConflict?.trim();
    const dup = await prisma.article.findFirst({
      where: { roleId, folderId, title, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, contentMarkdown: true },
    });

    if (dup && onConflict !== "overwrite" && onConflict !== "rename") {
      return reply.code(409).send({
        error: "duplicate_title",
        message: L(req, "该位置已存在同名文档", "A document with this name already exists here"),
        existing: { id: dup.id, title: dup.title },
      });
    }

    if (dup && onConflict === "overwrite") {
      const updated = await prisma.$transaction(async (tx) => {
        // 先把当前(导入前)内容存为历史版本,可回滚 —— 沿用 restore 的
        // 「先快照后替换」次序。kind=import 标记这是被导入覆盖前的快照。
        await tx.articleVersion.create({
          data: {
            articleId: dup.id,
            title: dup.title,
            contentMarkdown: dup.contentMarkdown,
            kind: "import",
            authorId: user.id,
          },
        });
        const u = await tx.article.update({
          where: { id: dup.id },
          data: { contentMarkdown },
          select: { id: true, title: true, folderId: true, roleId: true, sortOrder: true, createdAt: true, updatedAt: true },
        });
        await syncArticleLinks(tx, dup.id, contentMarkdown);
        return u;
      });
      markRoleSkillStale(roleId);
      reply.code(200);
      return {
        article: { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() },
        overwritten: true,
      };
    }

    // rename:在同容器内求一个未占用的「标题 (n)」(n 从 2 起)。
    // 占用集过滤用精确匹配(title 本身)或「title (数字)」模式,避免把
    // 「文档说明」算进「文档」的占用集导致 rename 序号跳空。
    let finalTitle = title;
    if (dup && onConflict === "rename") {
      const rows = await prisma.article.findMany({
        where: { roleId, folderId, deletedAt: null, title: { startsWith: title } },
        select: { title: true },
      });
      const suffixRe = /^ \(\d+\)$/;
      const taken = new Set(
        rows
          .map((r) => r.title)
          .filter((t) => t === title || (t.startsWith(title) && suffixRe.test(t.slice(title.length)))),
      );
      const base = title.length <= 250 ? title : title.slice(0, 250);
      let n = 2;
      while (taken.has(finalTitle) && n <= 1000) {
        finalTitle = `${base} (${n})`;
        n++;
      }
      // 循环结束时 finalTitle 仍被占用,说明 2..1000 号全满(第 1000 号空闲时不算耗尽)。
      if (taken.has(finalTitle)) {
        return reply.code(409).send({ error: "too_many_duplicates", message: L(req, "同名文档过多,请修改标题后重新导入", "Too many documents with the same name. Change the title and import again") });
      }
    }

    const sortAgg = await prisma.article.aggregate({
      where: folderId ? { folderId } : { folderId: null, roleId },
      _max: { sortOrder: true },
    });
    const nextSort = (sortAgg._max.sortOrder ?? 0) + 1;

    // Create + bind embedded uploads atomically. An imported .md can carry
    // `/uploads/...` references (e.g. a re-import of a previously-exported
    // doc whose asset URLs were rewritten back); binding inside the same
    // transaction anchors them so they can't be orphan-reaped, and matches
    // the CREATE / PATCH paths.
    const newArticleId = await uniqueArticleId();
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.article.create({
        data: {
          id: newArticleId,
          title: finalTitle,
          contentMarkdown,

          roleId,
          folderId: folderId,
          sortOrder: nextSort,
          createdById: user.id,
        },
        select: { id: true, title: true, folderId: true, roleId: true, sortOrder: true, createdAt: true, updatedAt: true },
      });
      await syncArticleLinks(tx, c.id, contentMarkdown);
      return c;
    });
    markRoleSkillStale(roleId);

    reply.code(201);
    return { article: { ...created, createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString() } };
  });

  // POST /api/articles/reorder — reorder articles within a sibling
  // group (same folder, or all role-direct under the same role).
  app.post("/api/articles/reorder", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = articleReorderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { roleId, folderId, ids } = parsed.data;

    const userRoleIds = await getUserRoleIds(user.id);
    const canEdit = user.isAdmin || userRoleIds.has(roleId);
    if (!canEdit) return reply.code(403).send({ error: "forbidden", message: L(req, "无权调整该角色下文档的顺序", "No permission to reorder documents under this role") });

    // Validate the sibling set AND write the new order inside ONE
    // transaction. Doing the membership + completeness checks in separate
    // queries before the writes was a TOCTOU: a concurrent create/delete
    // between the checks and the writes could pass a stale check and then
    // collide sortOrder with an omitted sibling (no unique constraint →
    // silent corruption). Inside the tx the checks are consistent with the
    // writes; conflicts surface as a 400 the FE retries after refresh.
    const result = await prisma.$transaction(async (tx) => {
      // Every id must belong to the claimed sibling group. Binned docs
      // aren't reorderable siblings, so exclude them.
      const rows = await tx.article.findMany({
        where: { id: { in: ids }, roleId, folderId: folderId ?? null, deletedAt: null },
        select: { id: true },
      });
      if (rows.length !== ids.length) {
        return { error: L(req, "部分文档不在该容器下", "Some documents are not in this container") };
      }
      // The submitted set must be COMPLETE: every live sibling in the
      // container has to appear. A partial list would rewrite only the
      // submitted rows to 0..n-1 and collide with the sortOrder of the
      // omitted siblings.
      const liveSiblingCount = await tx.article.count({
        where: { roleId, folderId: folderId ?? null, deletedAt: null },
      });
      if (ids.length !== liveSiblingCount) {
        return { error: L(req, "排序列表不完整，请刷新后重试", "The ordering list is incomplete. Refresh and try again") };
      }
      for (const [index, id] of ids.entries()) {
        await tx.article.update({ where: { id }, data: { sortOrder: index } });
      }
      return { error: null };
    });
    if (result.error) {
      return reply.code(400).send({ error: "invalid_input", message: result.error });
    }
    return { ok: true };
  });
}
