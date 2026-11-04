export interface FolderPermissions {
  canView: boolean;
  canEdit: boolean;
  isReadOnly: boolean;
}

export function getFolderPermissions(opts: {
  user: { id: string; isAdmin: boolean };
  userRoleIds: Set<string>;
  folder: { roleId: string; visibility: "public" | "private" };
}): FolderPermissions {
  // 目录没有私有范围：登录成员都能查看任何目录及其文档；编辑权只给该角色的成员和
  // 管理员(不能改别的团队的内容，但可以读)。没有草稿/发布流转，文档对所有登录成员可读。
  // (`folder.visibility` 被忽略，只为调用方类型兼容保留；API 拒绝写入 "private"。)
  const canEdit = opts.user.isAdmin || opts.userRoleIds.has(opts.folder.roleId);
  const canView = true;
  return { canView, canEdit, isReadOnly: !canEdit };
}

/// Synthetic FolderPermissions for role-direct articles (docs that
/// hang directly under a Role with no Folder wrap). 与目录一致：
/// 所有登录成员可查看，只有角色成员和管理员可编辑。
export function getRoleDirectPermissions(opts: {
  user: { id: string; isAdmin: boolean };
  userRoleIds: Set<string>;
  roleId: string;
}): FolderPermissions {
  // Role-direct docs (no folder): 所有登录成员可读；只有角色成员和管理员可编辑。
  const canEdit = opts.user.isAdmin || opts.userRoleIds.has(opts.roleId);
  return { canView: true, canEdit, isReadOnly: !canEdit };
}

export type FolderVisibilityValue = "public" | "private";
export function asFolderVisibility(v: string): FolderVisibilityValue {
  return v === "private" ? "private" : "public";
}


export interface ArticlePermissions {
  canView: boolean;
  canEdit: boolean;
  canBookmark: boolean;
  canCite: boolean;
  canExport: boolean;
  // True when the caller is the article's author or an admin — they
  // can grant / revoke other users' per-article edit access via the
  // `ArticleEditor` table. Collaborators (other users granted edit
  // access) explicitly do NOT get this — they cannot re-grant.
  canManageEditors: boolean;
  isReadOnly: boolean;
}

export function getArticlePermissions(opts: {
  folderPermissions: FolderPermissions;
  article: { createdById: string | null };
  userId: string;
  isAdmin: boolean;
  // Caller has been added to this article's per-article editor ACL.
  // Loaded by the route handler from the `ArticleEditor` table.
  isCollaborator?: boolean;
}): ArticlePermissions {
  const { folderPermissions: mp, article, userId, isAdmin, isCollaborator = false } = opts;
  const isAuthor = article.createdById !== null && article.createdById === userId;
  // Only author + admin manage the collaborator ACL — never the
  // collaborators themselves (would let edit grants spread without
  // the original author's say).
  const canManageEditors = isAdmin || isAuthor;

  // 去状态后:有 view 权限的人都能看;能改 = 目录可编辑 || 协作者 || 作者
  // (作者即使被移出角色,仍保留对自己文档的编辑权)。无编辑权限 → 只读。
  const folderCanEdit = mp.canEdit;
  const canEdit = folderCanEdit || isCollaborator || isAuthor;
  const canView = folderCanEdit || mp.canView || isCollaborator || isAuthor;
  return {
    canView,
    canEdit,
    canBookmark: canView,
    canCite: canView,
    canExport: canView,
    canManageEditors,
    isReadOnly: canView && !canEdit,
  };
}

import { prisma } from "../db.js";

export async function getUserRoleIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.userRole.findMany({ where: { userId }, select: { roleId: true } });
  return new Set(rows.map((r) => r.roleId));
}

/// Bulk-load "which of these articles has the caller been granted edit
/// access to". Single round-trip — used by list endpoints (folder
/// article list, my-collaborations) so permissions for N articles
/// don't fan out to N queries.
export async function getCollaboratorArticleIds(
  userId: string,
  articleIds: string[],
): Promise<Set<string>> {
  if (articleIds.length === 0) return new Set();
  const rows = await prisma.articleEditor.findMany({
    where: { userId, articleId: { in: articleIds } },
    select: { articleId: true },
  });
  return new Set(rows.map((r) => r.articleId));
}

/// Single-article version of the above — used by detail endpoints
/// where the caller hits exactly one article.
export async function isArticleCollaborator(
  userId: string,
  articleId: string,
): Promise<boolean> {
  const row = await prisma.articleEditor.findUnique({
    where: { articleId_userId: { articleId, userId } },
    select: { articleId: true },
  });
  return !!row;
}

/// Pick the right FolderPermissions for an article: when it lives in
/// a folder, use that folder's visibility rules; when it's role-direct
/// (no folder), use the role membership rule. Convenience wrapper —
/// call sites that have full article info can use this instead of
/// branching on `article.folderId === null` everywhere.
export function getEffectiveFolderPermissions(opts: {
  user: { id: string; isAdmin: boolean };
  userRoleIds: Set<string>;
  article: {
    roleId: string;
    folder: { roleId: string; visibility: string } | null;
  };
}): FolderPermissions {
  if (opts.article.folder) {
    return getFolderPermissions({
      user: opts.user,
      userRoleIds: opts.userRoleIds,
      folder: {
        roleId: opts.article.folder.roleId,
        visibility: asFolderVisibility(opts.article.folder.visibility),
      },
    });
  }
  return getRoleDirectPermissions({
    user: opts.user,
    userRoleIds: opts.userRoleIds,
    roleId: opts.article.roleId,
  });
}

