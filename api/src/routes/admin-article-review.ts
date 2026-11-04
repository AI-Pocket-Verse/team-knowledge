// 管理后台「文档 AI 入库前置校验」统一管理:
//   GET  /api/admin/article-review/issues     列出所有有问题(reviewStatus=issues)的文档 + findings
//   GET  /api/admin/article-review/dismissed  列出忽略集(关联文章标题;跳过已删/不存在文章)
//   POST /api/admin/article-review/undismiss  撤销某文章某条问题的忽略,并触发复检使其(如仍存在)重新冒出
// 一键优化 / 应用 / 忽略(整篇)沿用 routes/articles.ts 的 /articles/:id/review/*(管理员有编辑权)。
import { L, requestLang } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAdminOrOpenPage } from "../services/admin-visibility/index.js";
import { trackBestEffort } from "../utils/guards.js";
import { getAllDismissed, removeDismissed } from "../services/article-review/dismiss.js";
import { reviewArticle } from "../services/article-review/review.js";

function parseFindings(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function adminArticleReviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/article-review/issues", async (req, reply) => {
    const user = await requireAdminOrOpenPage(req, reply, "article-review");
    if (!user) return;

    const rows = await prisma.article.findMany({
      where: { deletedAt: null, reviewStatus: "issues" },
      orderBy: { reviewedAt: "desc" },
      select: {
        id: true, title: true, reviewFindings: true, reviewedAt: true, updatedAt: true,
        role: { select: { name: true } },
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        roleName: r.role?.name ?? null,
        findings: parseFindings(r.reviewFindings),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.get("/api/admin/article-review/dismissed", async (req, reply) => {
    const user = await requireAdminOrOpenPage(req, reply, "article-review");
    if (!user) return;

    const map = await getAllDismissed();
    const ids = Object.keys(map);
    if (ids.length === 0) return { items: [] };
    const arts = await prisma.article.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, title: true },
    });
    const titleById = new Map(arts.map((a) => [a.id, a.title]));

    const items: Array<{ articleId: string; articleTitle: string; hash: string; category: string; problem: string; dismissedAt: number; dismissedBy: string }> = [];
    for (const [articleId, byHash] of Object.entries(map)) {
      const articleTitle = titleById.get(articleId);
      if (!articleTitle) continue; // 文章已删/不存在 → 跳过(孤儿忽略项不展示)
      for (const [hash, it] of Object.entries(byHash)) {
        items.push({ articleId, articleTitle, hash, category: it.category, problem: it.problem, dismissedAt: it.dismissedAt, dismissedBy: it.dismissedBy });
      }
    }
    items.sort((a, b) => b.dismissedAt - a.dismissedAt);
    return { items };
  });

  // 撤销忽略会改变他人文档的校验状态并触发 AI 复检：页面放开给成员后也只有管理员能做。
  app.post("/api/admin/article-review/undismiss", async (req, reply) => {
    const user = await requireAdminOrOpenPage(req, reply, "article-review");
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "admin_only", message: L(req, "仅管理员可用", "Admins only") });

    const parsed = z.object({ articleId: z.string().min(1), hash: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: L(req, "参数错误", "Invalid parameters") });

    await removeDismissed(parsed.data.articleId, parsed.data.hash, user.id);
    // 让该文档「必被重新校验」:清掉 reviewedHash/reviewedAt —— 候选筛选据此判定需复检,
    // 即使下面这次立即复检因 LLM 繁忙/失败返回 null,扫描器下一轮也会兜底重检
    // (否则 reviewedAt 仍 >= updatedAt,撤销忽略后问题永远不会再冒出来)。$executeRaw 不 bump updatedAt。
    await prisma.$executeRaw`UPDATE "Article" SET "reviewedHash" = NULL, "reviewedAt" = NULL WHERE "id" = ${parsed.data.articleId}`;
    // 立即异步复检一次(快速反馈);失败也无妨,扫描器兜底。
    trackBestEffort(reviewArticle(parsed.data.articleId, { notify: false, lang: requestLang(req) }));
    return { ok: true };
  });
}
