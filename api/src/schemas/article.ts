import { z } from "zod";

// 去状态后:批量操作仅余删除(发布/归档已移除)。
const BULK_ACTION = z.enum(["delete"]);

// `roleId` is required (every doc lives under a role). `folderId` is
// optional — when omitted the doc is "role-direct" (sits at the role
// level in the sidebar tree, no folder wrap). When provided the doc
// goes into that folder.
//
// `title` accepts empty string: the editor lets users save without
// typing a title and the route handler normalizes "" / whitespace to
// the "未命名文档" sentinel. Keeping the schema permissive (instead
// of requiring the caller to send "未命名文档") means the storage
// fallback is a single source of truth, not duplicated client-side.
export const articleCreateSchema = z.object({
  roleId: z.string().min(1),
  folderId: z.string().min(1).nullish(),
  title: z.string().max(255),
  contentMarkdown: z.string().max(20_000_000),
});
export type ArticleCreateInput = z.infer<typeof articleCreateSchema>;

// Drag-reorder payload: list of ids in their new order, all at the
// same parent (same folder or all role-direct under same role).
// The caller must specify the parent context so we know which
// container to enforce the ordering scope on.
export const articleReorderSchema = z.object({
  // Exactly one of roleId / folderId is required. If folderId is
  // present, the ids belong inside that folder. If only roleId, the
  // ids are role-direct under that role.
  roleId: z.string().min(1),
  folderId: z.string().min(1).nullish(),
  ids: z.array(z.string().min(1)).min(1).max(500),
});
export type ArticleReorderInput = z.infer<typeof articleReorderSchema>;

// Move article to a new parent. `targetFolderId = null` means
// role-direct under the given role. `targetRoleId` is implied via
// the article's current roleId; we don't support cross-role moves
// in MVP (would change collaborator semantics, sort orders, etc.).
export const articleMoveSchema = z.object({
  targetFolderId: z.string().min(1).nullable(),
});
export type ArticleMoveInput = z.infer<typeof articleMoveSchema>;

// Import .md as a new doc. Title is editable in the dialog before
// commit — the route accepts the final title verbatim. roleId is
// required; folderId chooses the target folder (or null for
// role-direct). The file itself comes through multipart, not this
// JSON schema.
export const articleImportMetaSchema = z.object({
  roleId: z.string().min(1),
  folderId: z.string().min(1).nullable(),
  title: z.string().min(1).max(255),
});
export type ArticleImportMetaInput = z.infer<typeof articleImportMetaSchema>;

export const articleUpdateSchema = z
  .object({
    // Empty title is allowed (route normalizes to "未命名文档" — see
    // articleCreateSchema rationale). The .optional() means "field
    // absent ⇒ keep current title"; "" present ⇒ rename to untitled.
    title: z.string().max(255).optional(),
    contentMarkdown: z.string().max(20_000_000).optional(),
    /** Optimistic concurrency. When present, the server compares this
     *  to the row's updatedAt and rejects with 409 conflict if another
     *  writer has saved in the interim. ISO-8601 string. */
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine(
    (v) => {
      // The lock field by itself isn't a meaningful update.
      const fieldsCount = (v.title !== undefined ? 1 : 0)
        + (v.contentMarkdown !== undefined ? 1 : 0);
      return fieldsCount > 0;
    },
    { message: "至少需要一个字段" },
  );
export type ArticleUpdateInput = z.infer<typeof articleUpdateSchema>;

export const articleBulkSchema = z.object({
  action: BULK_ACTION,
  ids: z.array(z.string().min(1).max(40)).min(1).max(100),
});
export type ArticleBulkInput = z.infer<typeof articleBulkSchema>;

export const articleSearchSchema = z.object({
  q: z.string().min(1).max(64),
});
export type ArticleSearchInput = z.infer<typeof articleSearchSchema>;

export const bookmarkCreateSchema = z.object({
  articleId: z.string().min(1),
});
export type BookmarkCreateInput = z.infer<typeof bookmarkCreateSchema>;
