// 专家设定:管理员 或 该角色成员(UserRole)可读改。
//   GET   /api/admin/roles/:id/expert   读取(无配置时返回默认)
//   PATCH /api/admin/roles/:id/expert   改 instruction / 负责人 / 来源开关 / 启用
import { L } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { getUserRoleIds } from "../utils/permissions.js";
import { getExpert, setExpert } from "../services/experts/config.js";

// 能改这个角色的专家设定 = 管理员 或 该角色成员。
async function canEditRole(user: { id: string; isAdmin: boolean }, roleId: string): Promise<boolean> {
  if (user.isAdmin) return true;
  return (await getUserRoleIds(user.id)).has(roleId);
}

export async function adminExpertsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/admin/roles/:id/expert", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!(await canEditRole(user, req.params.id))) return reply.code(403).send({ error: "forbidden", message: L(req, "需要该角色权限或管理员", "Role permission or admin required") });
    return getExpert(req.params.id);
  });

  app.patch<{ Params: { id: string } }>("/api/admin/roles/:id/expert", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!(await canEditRole(user, req.params.id))) return reply.code(403).send({ error: "forbidden", message: L(req, "需要该角色权限或管理员", "Role permission or admin required") });

    const parsed = z.object({
      instruction: z.string().max(4000).optional(),
      ownerUserId: z.string().nullable().optional(),
      // 头像:仅接受本站上传视图 /uploads/<file>(由 POST /api/uploads/image 产出),或 null 清除。
      avatarUrl: z.string().regex(/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/).nullable().optional(),
      enabled: z.boolean().optional(),
      sources: z.object({
        kbDocs: z.boolean(), crossModule: z.boolean(), webSearch: z.boolean(), consult: z.boolean(),
      }).partial().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });

    // 负责人必须是真实且启用的用户(null = 清除负责人,允许)。否则升级会静默失效。
    if (parsed.data.ownerUserId) {
      const owner = await prisma.user.findUnique({ where: { id: parsed.data.ownerUserId }, select: { isActive: true } });
      if (!owner || !owner.isActive) return reply.code(400).send({ error: "invalid_input", message: L(req, "负责人不存在或已停用", "Owner not found or deactivated") });
    }

    const cur = await getExpert(req.params.id);
    // sources 部分更新:与当前合并,避免漏传的字段被重置。
    const sources = parsed.data.sources ? { ...cur.sources, ...parsed.data.sources } : undefined;
    const next = await setExpert(req.params.id, {
      ...(parsed.data.instruction !== undefined ? { instruction: parsed.data.instruction } : {}),
      ...(parsed.data.ownerUserId !== undefined ? { ownerUserId: parsed.data.ownerUserId } : {}),
      ...(parsed.data.avatarUrl !== undefined ? { avatarUrl: parsed.data.avatarUrl } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(sources ? { sources } : {}),
    }, user.id);
    return next;
  });
}
