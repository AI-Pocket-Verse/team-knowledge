import { z } from "zod";

// 文档目录没有私有范围：登录成员都能读全部文档，角色只决定编辑权(见 utils/permissions.ts)。
// 字段保留是为了兼容旧客户端和库里的列，但不接受 "private"，避免有人以为设置了就私有。
// (会议的 visibility:"private" 是生效的，与此无关。)
const VISIBILITY = z.enum(["public", "private"]).refine((v) => v !== "private", {
  message: "文档目录不支持私有可见范围：登录成员都能阅读全部文档，角色只决定编辑权限",
});

export const folderCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(255).nullable().optional(),
  visibility: VISIBILITY,
  roleId: z.string().min(1),
  // null / 省略 = 顶层目录;传顶层目录 id = 建子目录(深度封顶 2,父必须是顶层)。
  parentId: z.string().min(1).nullable().optional(),
});
export type FolderCreateInput = z.infer<typeof folderCreateSchema>;

export const folderUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().max(255).nullable().optional(),
    visibility: VISIBILITY.optional(),
    roleId: z.string().min(1).optional(),
    // Reparent: a folder id = nest under that (top-level) folder; null = promote
    // to top-level; omitted = leave the parent unchanged. Validated in the route
    // (target must be top-level, the moved folder must have no subfolders).
    parentId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "至少需要一个字段" });
export type FolderUpdateInput = z.infer<typeof folderUpdateSchema>;
