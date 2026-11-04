import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAdmin } from "../utils/guards.js";
import { roleCreateSchema, roleUpdateSchema } from "../schemas/admin.js";
import { uniqueRoleId } from "../utils/shortId.js";
import { ensureRoleSkillRow, markRoleSkillStale } from "../services/role-skill/stale.js";

type DbRoleWithCount = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: Date;
  // `folders` / `articles` are ALL rows (incl. soft-deleted), because
  // deleting a Role hard-cascades both — even binned ones — bypassing the
  // recycle bin. The delete guard and the frontend disable use these counts.
  _count: { userRoles: number; folders: number; articles: number };
};

function toPublic(r: DbRoleWithCount) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    createdAt: r.createdAt.toISOString(),
    memberCount: r._count.userRoles,
    // Surfaced so AdminRolesPage / DeleteRoleDialog can pre-disable delete
    // for a non-empty role (mirrors the 409 guard in DELETE below).
    folderCount: r._count.folders,
    articleCount: r._count.articles,
  };
}

const roleCountSelect = { select: { userRoles: true, folders: true, articles: true } } as const;

function loadRole(id: string) {
  return prisma.role.findUnique({
    where: { id },
    include: { _count: roleCountSelect },
  });
}

export async function adminRoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/roles", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const roles = await prisma.role.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: roleCountSelect },
    });
    return { roles: roles.map(toPublic) };
  });

  app.post("/api/admin/roles", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const parsed = roleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    try {
      const role = await prisma.role.create({
        // 8-char shortId for `/r/<id>` role-overview URLs. See
        // routes/articles.ts for the same pattern.
        data: {
          id: await uniqueRoleId(),
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          color: parsed.data.color ?? null,
        },
        include: { _count: roleCountSelect },
      });
      // Seed an (empty) skill row so the dispatcher produces the role's first skill.
      ensureRoleSkillRow(role.id);
      reply.code(201);
      return { role: toPublic(role) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(409).send({ error: "conflict", message: "角色名称已存在" });
      }
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/roles/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const existing = await loadRole(req.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found", message: "角色不存在" });
    try {
      const role = await prisma.role.update({
        where: { id: req.params.id },
        data: parsed.data,
        include: { _count: roleCountSelect },
      });
      // name/description feed the skill's frontmatter + sourceHash; mark stale.
      // (A color-only change leaves sourceHash unchanged → the no-op guard skips it.)
      markRoleSkillStale(role.id);
      return { role: toPublic(role) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(409).send({ error: "conflict", message: "角色名称已存在" });
      }
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/roles/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const existing = await loadRole(req.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found", message: "角色不存在" });
    // DATA LOSS GUARD: prisma.role.delete hard-cascades EVERY folder + article
    // (and their version/comment/like/bookmark/view children) under this role —
    // bypassing the recycle bin entirely, INCLUDING already-binned rows. Count
    // ALL folders/articles (no deletedAt filter) so deleting a role can never
    // silently purge live OR binned content. Only an empty role may be deleted.
    const [folders, articles] = await Promise.all([
      prisma.folder.count({ where: { roleId: req.params.id } }),
      prisma.article.count({ where: { roleId: req.params.id } }),
    ]);
    if (folders > 0 || articles > 0) {
      return reply.code(409).send({
        error: "conflict",
        message: `该角色下还有 ${folders} 个目录、${articles} 篇文档,请先删除或迁移后再删除角色`,
        folders,
        articles,
      });
    }
    await prisma.role.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });
}
