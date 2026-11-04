import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { getFolderPermissions, asFolderVisibility, getUserRoleIds } from "../utils/permissions.js";
import { folderCreateSchema, folderUpdateSchema } from "../schemas/folder.js";
import { uniqueFolderId } from "../utils/shortId.js";
import { acquireKeyedLock } from "../utils/keyedMutex.js";

const folderReorderSchema = z.object({
  roleId: z.string().min(1),
  // The sibling group being reordered: null/omitted = top-level folders;
  // otherwise the subfolders under this parent.
  parentId: z.string().min(1).nullable().optional(),
  ids: z.array(z.string().min(1)).min(1).max(500),
});

type DbFolderWithRelations = Prisma.FolderGetPayload<{
  include: { role: true; createdBy: { select: { id: true; displayName: true } } };
}>;

function toFolderWithRole(m: DbFolderWithRelations, permissions: ReturnType<typeof getFolderPermissions>) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    roleId: m.roleId,
    parentId: m.parentId,
    visibility: asFolderVisibility(m.visibility),
    templateType: m.templateType,
    createdById: m.createdById,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    permissions,
    role: {
      id: m.role.id,
      name: m.role.name,
      description: m.role.description,
      color: m.role.color,
      createdAt: m.role.createdAt.toISOString(),
    },
    createdBy: m.createdBy,
  };
}

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/folders", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = folderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const { name, description, visibility, roleId, parentId } = parsed.data;
    const normParent = parentId ?? null;

    // 同一 (roleId, parentId) 下「查同名 → 写入」必须串行:唯一索引 @@unique([roleId,parentId,name])
    // 对顶层目录无效(parentId 为 NULL,SQLite 中 NULL 互不相等),并发请求会都查不到同名而各自写入。
    // 服务是单进程 SQLite,进程内互斥足够;不改 schema、不需要迁移与清理历史重复数据。
    const release = await acquireKeyedLock(`${roleId}|${normParent ?? ""}`);
    try {
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) return reply.code(404).send({ error: "not_found", message: "角色不存在" });

      const userRoleIds = await getUserRoleIds(user.id);
      const canEditTarget = user.isAdmin || userRoleIds.has(role.id);
      if (!canEditTarget) {
        return reply.code(403).send({ error: "forbidden", message: "无权在该角色下创建目录" });
      }

      // Subfolder support (2-level cap). A parent must exist, be live, belong to
      // the SAME role, and itself be top-level (parentId null) — otherwise we'd
      // exceed two levels.
      if (normParent !== null) {
        const parent = await prisma.folder.findUnique({ where: { id: normParent } });
        if (!parent || parent.deletedAt != null || parent.roleId !== roleId) {
          return reply.code(400).send({ error: "invalid_input", message: "父目录不存在或不在该角色下" });
        }
        if (parent.parentId != null) {
          return reply.code(400).send({ error: "invalid_input", message: "子目录下不能再新建目录（最多两级）" });
        }
      }

      // New folder lands at the bottom of the role's folder list — give
      // it max(currentSortOrder)+1 so it ends up after every existing
      // folder when the sidebar sorts ascending. New rows on a fresh
      // role start at 1.
      const sortAgg = await prisma.folder.aggregate({
        where: { roleId, parentId: normParent },
        _max: { sortOrder: true },
      });
      const nextSort = (sortAgg._max.sortOrder ?? 0) + 1;

      // Duplicate-name handling across the recycle bin. @@unique([roleId,parentId,name])
      // spans soft-deleted rows, but the tree only shows deletedAt: null — so a
      // folder sitting in the RECYCLE BIN would otherwise block re-creating its
      // name with "已有同名" for a folder the user can't even see. Distinguish:
      //   - a LIVE same-name folder  → a real conflict (409).
      //   - a recycled one           → free its name (a deleted folder must not
      //                                 reserve a name forever). The rename is done
      //                                 INSIDE the create transaction below so a
      //                                 failed create can't strand the binned row
      //                                 renamed (it stays restorable either way).
      const sameName = await prisma.folder.findFirst({
        where: { roleId, parentId: normParent, name },
        select: { id: true, deletedAt: true },
      });
      if (sameName && sameName.deletedAt == null) {
        return reply.code(409).send({ error: "conflict", message: "同一角色下已有同名目录" });
      }
      const recycledSameNameId = sameName?.id ?? null;
      // 8-char shortId for URLs `/m/<8chars>` — resolved before the tx (it does its
      // own uniqueness read; keep it off the write connection).
      const newId = await uniqueFolderId();

      try {
        const created = await prisma.$transaction(async (tx) => {
          if (recycledSameNameId) {
            await tx.folder.update({
              where: { id: recycledSameNameId },
              data: { name: `${name}（已删除 ${recycledSameNameId.slice(0, 6)}）` },
            });
          }
          return tx.folder.create({
            data: {
              id: newId,
              name,
              description: description ?? null,
              visibility,
              roleId,
              parentId: normParent,
              sortOrder: nextSort,
              createdById: user.id,
            },
            include: {
              role: true,
              createdBy: { select: { id: true, displayName: true } },
            },
          });
        });
        const permissions = getFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          folder: { roleId: created.roleId, visibility: asFolderVisibility(created.visibility) },
        });
        reply.code(201);
        return { folder: toFolderWithRole(created, permissions) };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return reply.code(409).send({ error: "conflict", message: "同一角色下已有同名目录" });
        }
        throw e;
      }
    } finally {
      release();
    }
  });

  app.patch<{ Params: { id: string } }>("/api/folders/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = folderUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const data = parsed.data;

    const existing = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "目录不存在" });

    const userRoleIds = await getUserRoleIds(user.id);
    const canEdit = user.isAdmin || userRoleIds.has(existing.roleId);
    if (!canEdit) return reply.code(403).send({ error: "forbidden", message: "无权编辑该目录" });

    if (data.roleId !== undefined && data.roleId !== existing.roleId) {
      if (!user.isAdmin) {
        return reply.code(403).send({ error: "forbidden", message: "仅管理员可重新归属角色" });
      }
      const newRole = await prisma.role.findUnique({ where: { id: data.roleId } });
      if (!newRole) return reply.code(404).send({ error: "not_found", message: "目标角色不存在" });
    }

    // When the folder is reassigned to a different role, its child
    // articles' denormalized `roleId` must follow — Article.roleId is
    // required and queried directly (role-direct lookups, feed, search),
    // so a stale child roleId would mis-scope the doc. Update ALL children
    // regardless of deletedAt so soft-deleted docs stay consistent for
    // restore. Done in the SAME transaction as the folder update so the
    // folder and its children never diverge.
    const newRoleId =
      data.roleId !== undefined && data.roleId !== existing.roleId ? data.roleId : null;
    const targetRoleId = newRoleId ?? existing.roleId;

    // ── Reparent (drag a folder into another, or out to top-level) ────────
    // data.parentId === undefined → leave parent unchanged. null → promote to
    // top-level. a folder id → nest under that (must be a top-level) folder.
    const reparenting = data.parentId !== undefined && (data.parentId ?? null) !== existing.parentId;
    const newParentId = reparenting ? (data.parentId ?? null) : existing.parentId;
    if (reparenting && newParentId !== null) {
      if (newParentId === existing.id) {
        return reply.code(400).send({ error: "invalid_input", message: "不能把目录移动到它自己里" });
      }
      const parent = await prisma.folder.findUnique({ where: { id: newParentId } });
      if (!parent || parent.deletedAt != null || parent.roleId !== targetRoleId) {
        return reply.code(400).send({ error: "invalid_input", message: "目标目录不存在或不在该角色下" });
      }
      if (parent.parentId != null) {
        return reply.code(400).send({ error: "invalid_input", message: "不能移动到子目录下（最多两级）" });
      }
      // A folder that itself contains subfolders can't be nested — that would
      // push its own children to level 3.
      const childCount = await prisma.folder.count({ where: { parentId: existing.id, deletedAt: null } });
      if (childCount > 0) {
        return reply.code(400).send({ error: "invalid_input", message: "含子目录的目录不能移动到别的目录" });
      }
    }

    // Cross-role move of a SUBFOLDER without an explicit reparent would leave
    // its parentId pointing at a parent in the OLD role. The /tree builder groups
    // by roleId, so the subfolder would vanish from BOTH roles' trees. Promote it
    // to top-level in the new role instead (depth stays ≤ 2).
    const effectiveParentId =
      newRoleId !== null && !reparenting && existing.parentId !== null ? null : newParentId;
    const parentChanged = effectiveParentId !== existing.parentId;

    // Duplicate-name handling. @@unique([roleId, parentId, name]) spans
    // soft-deleted rows, so renaming / reassigning role / reparenting onto a
    // (roleId, parentId, name) held ONLY by a binned folder would 409 on a
    // folder the user can't even see. A LIVE holder → real 409; a RECYCLED holder
    // → free its name INSIDE the update transaction below (so a failed update
    // can't strand the binned row renamed).
    // 目标位置 (roleId, parentId) 下「查同名 → 写入」必须串行:唯一索引 @@unique([roleId,parentId,name])
    // 对顶层目录无效(parentId 为 NULL,SQLite 中 NULL 互不相等),并发请求会都查不到同名而各自写入。
    // 服务是单进程 SQLite,进程内互斥足够;不改 schema、不需要迁移与清理历史重复数据。
    const release = await acquireKeyedLock(`${targetRoleId}|${effectiveParentId ?? ""}`);
    try {
      const targetName = data.name !== undefined ? data.name : existing.name;
      let recycledSameNameId: string | null = null;
      if (targetName !== existing.name || targetRoleId !== existing.roleId || parentChanged) {
        const sameName = await prisma.folder.findFirst({
          where: { roleId: targetRoleId, parentId: effectiveParentId, name: targetName, id: { not: existing.id } },
          select: { id: true, deletedAt: true },
        });
        if (sameName) {
          if (sameName.deletedAt == null) {
            return reply.code(409).send({ error: "conflict", message: "目标位置已有同名目录" });
          }
          recycledSameNameId = sameName.id;
        }
      }

      // When the parent changes (reparent, promote, or cross-role auto-promote),
      // append to the end of the new sibling group.
      let newSort: number | undefined;
      if (parentChanged) {
        const agg = await prisma.folder.aggregate({
          where: { roleId: targetRoleId, parentId: effectiveParentId },
          _max: { sortOrder: true },
        });
        newSort = (agg._max.sortOrder ?? 0) + 1;
      }

      try {
        const updated = await prisma.$transaction(async (tx) => {
          if (recycledSameNameId) {
            await tx.folder.update({
              where: { id: recycledSameNameId },
              data: { name: `${targetName}（已删除 ${recycledSameNameId.slice(0, 6)}）` },
            });
          }
          const f = await tx.folder.update({
            where: { id: existing.id },
            data: { ...data, ...(parentChanged ? { parentId: effectiveParentId, sortOrder: newSort } : {}) },
            include: {
              role: true,
              createdBy: { select: { id: true, displayName: true } },
            },
          });
          if (newRoleId !== null) {
            // Subfolders follow the parent to the new role; the denormalized
            // roleId on every article in the whole subtree (this folder + its
            // subfolders) must follow too. Depth is capped at 2, so children
            // have no further descendants to chase.
            const childIds = (
              await tx.folder.findMany({ where: { parentId: existing.id }, select: { id: true } })
            ).map((c) => c.id);
            if (childIds.length) {
              await tx.folder.updateMany({ where: { id: { in: childIds } }, data: { roleId: newRoleId } });
            }
            await tx.article.updateMany({
              where: { folderId: { in: [existing.id, ...childIds] } },
              data: { roleId: newRoleId },
            });
          }
          return f;
        });
        const permissions = getFolderPermissions({
          user: { id: user.id, isAdmin: user.isAdmin },
          userRoleIds,
          folder: { roleId: updated.roleId, visibility: asFolderVisibility(updated.visibility) },
        });
        return { folder: toFolderWithRole(updated, permissions) };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return reply.code(409).send({ error: "conflict", message: "同一角色下已有同名目录" });
        }
        throw e;
      }
    } finally {
      release();
    }
  });

  // DELETE /api/folders/:id — soft-delete into the deleter's recycle
  // bin. Per the recycle-bin product decision the folder and ALL its
  // currently-live child articles (and subfolders + their articles) go into the
  // bin TOGETHER, sharing one deletedAt instant + deletedById. That shared
  // timestamp is the ONLY thing that lets folder-restore / purge re-unite
  // exactly the rows that went down with it (see routes/recycle-bin.ts) — any
  // future code that soft-deletes a folder subtree MUST stamp the whole subtree
  // with a single shared Date, never a per-row `new Date()`. Permanent removal
  // happens from the bin.
  app.delete<{ Params: { id: string } }>("/api/folders/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const fold = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!fold || fold.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "目录不存在" });
    const userRoleIds = await getUserRoleIds(user.id);
    const canEdit = user.isAdmin || userRoleIds.has(fold.roleId);
    if (!canEdit) return reply.code(403).send({ error: "forbidden", message: "无权删除该目录" });

    // One shared timestamp for the whole subtree (folder + its subfolders +
    // every live article in them) so restore can re-unite them by exact
    // deletedAt equality. A top-level folder cascades to its subfolders; a
    // subfolder has no further descendants (depth capped at 2), so childIds
    // is simply empty and this degrades to the single-folder case.
    const D = new Date();
    const childIds = (
      await prisma.folder.findMany({ where: { parentId: fold.id, deletedAt: null }, select: { id: true } })
    ).map((c) => c.id);
    // 与单篇删除一致：文档只能由作者或管理员删除。非管理员删除的目录里有其他成员的文档
    // (含作者已被删除、createdById 为空的)时拒绝，否则这些文档会进他的回收站、还能被他彻底清除。
    if (!user.isAdmin) {
      const othersDocs = await prisma.article.count({
        where: {
          folderId: { in: [fold.id, ...childIds] },
          deletedAt: null,
          OR: [{ createdById: { not: user.id } }, { createdById: null }],
        },
      });
      if (othersDocs > 0) {
        return reply.code(403).send({
          error: "folder_has_others_docs",
          message: `目录里有 ${othersDocs} 篇其他成员的文档，只有管理员能删除整个目录`,
        });
      }
    }
    await prisma.$transaction([
      prisma.article.updateMany({
        where: { folderId: { in: [fold.id, ...childIds] }, deletedAt: null },
        data: { deletedAt: D, deletedById: user.id },
      }),
      prisma.folder.updateMany({
        where: { id: { in: childIds }, deletedAt: null },
        data: { deletedAt: D, deletedById: user.id },
      }),
      prisma.folder.update({
        where: { id: fold.id },
        data: { deletedAt: D, deletedById: user.id },
      }),
    ]);

    return reply.code(204).send();
  });

  // POST /api/folders/reorder — drag-reorder folders within a role.
  // Body { roleId, ids: orderedIds[] }. Writes sortOrder = index for
  // each id in a single transaction so the sidebar gets a consistent
  // snapshot.
  app.post("/api/folders/reorder", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = folderReorderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const { roleId, parentId, ids } = parsed.data;
    const normParent = parentId ?? null;

    const userRoleIds = await getUserRoleIds(user.id);
    const canEdit = user.isAdmin || userRoleIds.has(roleId);
    if (!canEdit) return reply.code(403).send({ error: "forbidden", message: "无权调整该角色下目录顺序" });

    // Validate the sibling set AND write the new order inside ONE
    // transaction. Running the membership + completeness checks in separate
    // queries before the writes was a TOCTOU: a concurrent create/delete
    // between the checks and the writes could pass a stale check and then
    // collide sortOrder with an omitted folder (no unique constraint →
    // silent corruption). Inside the tx the checks are consistent with the
    // writes; conflicts surface as a 400 the FE retries after refresh.
    const result = await prisma.$transaction(async (tx) => {
      // Sanity: every id must belong to the claimed role. Wrong-role
      // ids are silently ignored otherwise, which would let a caller
      // covertly reorder a folder they don't own.
      const rows = await tx.folder.findMany({
        where: { id: { in: ids }, roleId, parentId: normParent, deletedAt: null },
        select: { id: true },
      });
      if (rows.length !== ids.length) {
        return { error: "部分目录不在该分组下" as const };
      }
      // The submitted set must be COMPLETE: every live folder in the role
      // has to appear. A partial list would rewrite only the submitted rows
      // to 0..n-1 and collide with the sortOrder of the omitted folders.
      const liveSiblingCount = await tx.folder.count({
        where: { roleId, parentId: normParent, deletedAt: null },
      });
      if (ids.length !== liveSiblingCount) {
        return { error: "排序列表不完整，请刷新后重试" as const };
      }
      for (const [index, id] of ids.entries()) {
        await tx.folder.update({ where: { id }, data: { sortOrder: index } });
      }
      return { error: null };
    });
    if (result.error) {
      return reply.code(400).send({ error: "invalid_input", message: result.error });
    }
    return { ok: true };
  });
}
