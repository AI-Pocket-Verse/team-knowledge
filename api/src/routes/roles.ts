// 角色相关只读接口。
//   GET /api/roles/:id/members  角色成员(用于「负责人/转交目标」选人建议列表)
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";

export async function rolesRoutes(app: FastifyInstance): Promise<void> {
  // 任意登录用户可读,仅姓名/头像(非敏感),供选人控件预填该角色成员。
  app.get<{ Params: { id: string } }>("/api/roles/:id/members", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rows = await prisma.userRole.findMany({
      where: { roleId: req.params.id },
      select: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
      orderBy: { user: { displayName: "asc" } },
    });
    return { members: rows.map((r) => ({ userId: r.user.id, displayName: r.user.displayName, avatarUrl: r.user.avatarUrl })) };
  });
}
