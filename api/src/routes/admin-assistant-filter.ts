// 管理后台:助手内容过滤清单(增 / 删 / 列,仅管理员)。被排除的角色 / 文件夹 /
// 文档不进入助手的检索与分析(问答 / 会议讨论 / 群聊答疑 / 文档体检)。仅影响
//助手的 AI,不影响用户的浏览与权限。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAdmin } from "../utils/guards.js";
import { invalidateAssistantExclusionCache } from "../services/assistant-filter/exclusions.js";

const bodySchema = z.object({
  targetType: z.enum(["role", "folder", "article"]),
  targetId: z.string().min(1),
});

// 校验排除目标存在且「在线」。Folder / Article 有软删除(回收站),已删除的目标
// 不允许新增排除(用 findFirst 才能带 deletedAt 过滤;findUnique 只接受唯一键)。
// Role 无软删除,沿用 findUnique。
async function targetExists(targetType: string, targetId: string): Promise<boolean> {
  if (targetType === "role") return !!(await prisma.role.findUnique({ where: { id: targetId }, select: { id: true } }));
  if (targetType === "folder") return !!(await prisma.folder.findFirst({ where: { id: targetId, deletedAt: null }, select: { id: true } }));
  return !!(await prisma.article.findFirst({ where: { id: targetId, deletedAt: null }, select: { id: true } }));
}

export async function adminAssistantFilterRoutes(app: FastifyInstance): Promise<void> {
  // 列出已排除项(join 取展示名)。孤儿行不展示:目标硬删除 → join 不到;目标软
  // 删除(回收站)→ deletedAt:null 过滤掉。两种都视作"不再是可见目标",避免界面
  // 出现回收站里的条目或空名条目(排除行本身无害地留在表里,见设计文档)。
  app.get("/api/admin/assistant-filter", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const rows = await prisma.assistantExclusion.findMany({ select: { targetType: true, targetId: true } });
    const roleIds = rows.filter((r) => r.targetType === "role").map((r) => r.targetId);
    const folderIds = rows.filter((r) => r.targetType === "folder").map((r) => r.targetId);
    const articleIds = rows.filter((r) => r.targetType === "article").map((r) => r.targetId);
    const [roles, folders, articles] = await Promise.all([
      prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }),
      prisma.folder.findMany({ where: { id: { in: folderIds }, deletedAt: null }, select: { id: true, name: true, roleId: true, parentId: true } }),
      prisma.article.findMany({ where: { id: { in: articleIds }, deletedAt: null }, select: { id: true, title: true, roleId: true, folderId: true } }),
    ]);
    return { roles, folders, articles };
  });

  // 添加排除(幂等 upsert)。
  app.post("/api/admin/assistant-filter", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const { targetType, targetId } = parsed.data;
    if (!(await targetExists(targetType, targetId))) return reply.code(404).send({ error: "not_found", message: "目标不存在" });
    await prisma.assistantExclusion.upsert({
      where: { targetType_targetId: { targetType, targetId } },
      create: { targetType, targetId, createdById: user.id },
      update: {},
    });
    invalidateAssistantExclusionCache();
    return { ok: true };
  });

  // 移除排除(幂等)。
  app.delete("/api/admin/assistant-filter", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const { targetType, targetId } = parsed.data;
    await prisma.assistantExclusion.deleteMany({ where: { targetType, targetId } });
    invalidateAssistantExclusionCache();
    return { ok: true };
  });
}
