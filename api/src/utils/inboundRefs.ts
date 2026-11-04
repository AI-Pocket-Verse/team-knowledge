import { asFolderVisibility, getArticlePermissions, getEffectiveFolderPermissions } from "./permissions.js";

// One inbound reference row. After the folders/docs refactor each
// referencing article may or may not live inside a folder — both
// `folderId` and `folder` can be null for role-direct docs; `roleId`
// is always set (the article's own denormalized field).
export interface InboundRef {
  fromArticle: {
    id: string;
    title: string;
    folderId: string | null;
    roleId: string;
    createdById: string | null;
    folder: { roleId: string; visibility: string } | null;
  };
}

export interface InboundRefView {
  id: string;
  title: string;
  folderId: string | null;
  roleId: string;
}

export function filterVisibleInboundRefs(
  refs: InboundRef[],
  user: { id: string; isAdmin: boolean },
  userRoleIds: Set<string>,
  collabIds: Set<string> = new Set(),
): InboundRefView[] {
  return refs
    .filter((ref) => {
      const refMp = getEffectiveFolderPermissions({
        user,
        userRoleIds,
        article: { roleId: ref.fromArticle.roleId, folder: ref.fromArticle.folder },
      });
      const refPerms = getArticlePermissions({
        folderPermissions: refMp,
        article: { createdById: ref.fromArticle.createdById },
        userId: user.id,
        isAdmin: user.isAdmin,
        isCollaborator: collabIds.has(ref.fromArticle.id),
      });
      return refPerms.canView;
    })
    .map((ref) => ({
      id: ref.fromArticle.id,
      title: ref.fromArticle.title,
      folderId: ref.fromArticle.folderId,
      roleId: ref.fromArticle.roleId,
    }));
}

// Re-export so callers don't need to also import asFolderVisibility.
export { asFolderVisibility };
