import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAdmin, isBootstrapAdminRow } from "../utils/guards.js";
import { adminUserUpdateSchema } from "../schemas/admin.js";

type DbUserWithRoles = Prisma.UserGetPayload<{
  include: { roles: { include: { role: true } } };
}>;

function toPublic(u: DbUserWithRoles) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    isAdmin: u.isAdmin,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
    roles: u.roles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      description: ur.role.description,
      color: ur.role.color,
      createdAt: ur.role.createdAt.toISOString(),
    })),
  };
}

function loadUsers() {
  return prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    include: { roles: { include: { role: true } } },
  });
}

function loadUser(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: { roles: { include: { role: true } } },
  });
}

async function assertRoleIdsExist(ids: string[]) {
  if (ids.length === 0) return true;
  const found = await prisma.role.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return found.length === ids.length;
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/users", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const users = await loadUsers();
    return { users: users.map(toPublic) };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const parsed = adminUserUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const existing = await loadUser(req.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found", message: "用户不存在" });

    const data = parsed.data;
    const isSelf = existing.id === admin.id;

    // Self guards
    if (isSelf && data.isAdmin === false) {
      return reply.code(403).send({ error: "forbidden", message: "不能取消自己的管理员权限" });
    }
    if (isSelf && data.isActive === false) {
      return reply.code(403).send({ error: "forbidden", message: "不能禁用自己" });
    }

    // Bootstrap-admin guard: a configured (ADMIN_PHONES / ADMIN_EMAILS /
    // ADMIN_OPEN_IDS) admin is re-asserted to isAdmin on every login, so
    // demoting/deactivating one only creates a zombie half-state (or, post
    // guards.ts fix, a row that flips back to active on next login). Block the
    // mutation outright and point at the real lever — the env allowlists.
    if ((data.isActive === false || data.isAdmin === false) && isBootstrapAdminRow(existing)) {
      return reply.code(403).send({
        error: "forbidden",
        message: "无法停用或降权配置内置管理员,请修改 ADMIN_PHONES 等环境变量",
      });
    }

    // Last-admin demotion guard
    if (data.isAdmin === false && existing.isAdmin && !isSelf) {
      const otherAdmins = await prisma.user.count({
        where: { isAdmin: true, isActive: true, id: { not: existing.id } },
      });
      if (otherAdmins === 0) {
        return reply.code(403).send({ error: "forbidden", message: "不能取消最后一名管理员" });
      }
    }

    // Last-admin deactivation guard: deactivating an admin locks them out just
    // as hard as demotion, but the demotion guard above doesn't fire on an
    // isActive:false-only PATCH. Block deactivating the LAST active admin.
    if (data.isActive === false && existing.isAdmin && !isSelf) {
      const otherActiveAdmins = await prisma.user.count({
        where: { isAdmin: true, isActive: true, id: { not: existing.id } },
      });
      if (otherActiveAdmins === 0) {
        return reply.code(403).send({ error: "forbidden", message: "不能停用最后一名管理员" });
      }
    }

    // roleIds existence check
    if (data.roleIds && !(await assertRoleIdsExist(data.roleIds))) {
      return reply.code(400).send({ error: "invalid_input", message: "存在无效的角色 id" });
    }

    const { roleIds, ...scalar } = data;
    const updateData: Prisma.UserUpdateInput = { ...scalar };
    if (roleIds) {
      updateData.roles = {
        deleteMany: {},
        create: roleIds.map((roleId) => ({ roleId })),
      };
    }

    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: updateData,
      include: { roles: { include: { role: true } } },
    });
    return { user: toPublic(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/users/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    if (target.id === admin.id) {
      return reply.code(403).send({ error: "forbidden", message: "不能删除自己" });
    }
    // 与 PATCH 一致:配置内置管理员每次登录都会被重新置为管理员,删掉只会留下僵尸行。
    if (isBootstrapAdminRow(target)) {
      return reply.code(403).send({
        error: "forbidden",
        message: "无法删除配置内置管理员,请修改 ADMIN_PHONES 等环境变量",
      });
    }
    if (target.isAdmin) {
      const otherAdmins = await prisma.user.count({
        where: { isAdmin: true, isActive: true, id: { not: target.id } },
      });
      if (otherAdmins === 0) {
        return reply.code(403).send({ error: "forbidden", message: "不能删除最后一名管理员" });
      }
    }
    // 上传记录与会议随用户级联删除:别人文档里引用的图片会 404、会议纪要丢失。
    // 有内容的用户只能停用(isActive=false),不能删除。
    const [uploads, meetings] = await Promise.all([
      prisma.upload.count({ where: { uploadedById: target.id } }),
      prisma.meetingSession.count({ where: { createdById: target.id } }),
    ]);
    if (uploads > 0 || meetings > 0) {
      return reply.code(409).send({
        error: "user_has_content",
        message: `该用户有 ${uploads} 个上传文件、${meetings} 场会议，删除会一并丢失，请改为禁用`,
        uploads,
        meetings,
      });
    }
    await prisma.user.delete({ where: { id: target.id } });
    return reply.code(204).send();
  });
}
