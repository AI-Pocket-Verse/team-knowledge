import type { FastifyInstance } from "fastify";
import type { PublicUserProfileResponse } from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { getPublicArticles, getPublicActivity } from "../services/publicProfile.js";

/**
 * Public per-user profile — viewable by ANY logged-in user. Three endpoints:
 *   - GET /api/users/:id            → identity card (no email).
 *   - GET /api/users/:id/articles   → the target's non-draft docs, ACL-filtered
 *                                      to the VIEWER (FeedResponse shape).
 *   - GET /api/users/:id/activity   → the target's PUBLIC contribution feed,
 *                                      ACL-filtered to the VIEWER
 *                                      (AdminActivityPageResponse shape).
 *
 * Route-shadowing note: `/api/users/search` (article-editors route) is STATIC
 * and `/api/users/:id` is PARAMETRIC. Fastify's find-my-way router always
 * matches a static segment before a parametric one regardless of registration
 * order, so `/users/search` keeps resolving to the search handler and never
 * falls into `:id`. The two coexist with no ordering requirement.
 */
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/users/:id — public identity. Email is NEVER returned.
  app.get<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, displayName: true, avatarUrl: true, isAdmin: true, isActive: true, createdAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    // 404 for a missing OR deactivated account — a disabled user has no public
    // profile, and we don't distinguish the two to avoid leaking existence.
    if (!target || !target.isActive) {
      return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    }
    // Count the target's live (non-deleted) authored docs. 去草稿后不再区分状态;
    // 这是公开贡献度指标(类似提交数),非内容列表,不泄露任何正文。
    const publishedCount = await prisma.article.count({
      where: { createdById: target.id, deletedAt: null },
    });
    const body: PublicUserProfileResponse = {
      id: target.id,
      displayName: target.displayName,
      avatarUrl: target.avatarUrl,
      isAdmin: target.isAdmin,
      roles: target.roles.map((r) => r.role.name),
      createdAt: target.createdAt.toISOString(),
      publishedCount,
    };
    return body;
  });

  // GET /api/users/:id/articles — target's non-draft docs, ACL-filtered to me.
  app.get<{ Params: { id: string } }>("/api/users/:id/articles", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // Confirm the target exists + is active so a 404 stays consistent with the
    // profile endpoint (an inactive/missing user has no public surface at all).
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, isActive: true },
    });
    if (!target || !target.isActive) {
      return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    }
    return getPublicArticles(target.id, { id: user.id, isAdmin: user.isAdmin });
  });

  // GET /api/users/:id/activity?page= — target's public contribution feed,
  // ACL-filtered to me.
  app.get<{ Params: { id: string }; Querystring: { page?: string } }>(
    "/api/users/:id/activity",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const target = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, displayName: true, isActive: true },
      });
      if (!target || !target.isActive) {
        return reply.code(404).send({ error: "not_found", message: "用户不存在" });
      }
      const pageRaw = Number(req.query.page);
      const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
      return getPublicActivity({
        targetId: target.id,
        targetName: target.displayName,
        viewer: { id: user.id, isAdmin: user.isAdmin },
        page,
      });
    },
  );
}
