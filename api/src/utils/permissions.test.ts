import { describe, it, expect } from "vitest";
import { getFolderPermissions } from "./permissions.js";

const ADMIN = { id: "a", isAdmin: true };
const USER  = { id: "u", isAdmin: false };

describe("getFolderPermissions", () => {
  it("admin: full access to a PUBLIC folder regardless of role membership", () => {
    const r = getFolderPermissions({
      user: ADMIN,
      userRoleIds: new Set(),
      folder: { roleId: "r1", visibility: "public" },
    });
    expect(r).toEqual({ canView: true, canEdit: true, isReadOnly: false });
  });

  it("admin: full access to a PRIVATE folder even when NOT a role-member (admins manage everything)", () => {
    const r = getFolderPermissions({
      user: ADMIN,
      userRoleIds: new Set(),
      folder: { roleId: "r1", visibility: "private" },
    });
    expect(r).toEqual({ canView: true, canEdit: true, isReadOnly: false });
  });

  it("admin who IS a role-member: full access to that role's private folder", () => {
    const r = getFolderPermissions({
      user: ADMIN,
      userRoleIds: new Set(["r1"]),
      folder: { roleId: "r1", visibility: "private" },
    });
    expect(r).toEqual({ canView: true, canEdit: true, isReadOnly: false });
  });

  it("role-owner: full access to own role's folders regardless of visibility", () => {
    for (const visibility of ["public", "private"] as const) {
      const r = getFolderPermissions({
        user: USER,
        userRoleIds: new Set(["r1"]),
        folder: { roleId: "r1", visibility },
      });
      expect(r).toEqual({ canView: true, canEdit: true, isReadOnly: false });
    }
  });

  it("non-owner, public folder: read-only view", () => {
    const r = getFolderPermissions({
      user: USER,
      userRoleIds: new Set(["other"]),
      folder: { roleId: "r1", visibility: "public" },
    });
    expect(r).toEqual({ canView: true, canEdit: false, isReadOnly: true });
  });

  it("non-owner, private folder: read-only VIEW (folders are public containers now)", () => {
    const r = getFolderPermissions({
      user: USER,
      userRoleIds: new Set(["other"]),
      folder: { roleId: "r1", visibility: "private" },
    });
    expect(r).toEqual({ canView: true, canEdit: false, isReadOnly: true });
  });

  it("non-owner with no roles: read-only view on every folder regardless of the (ignored) visibility", () => {
    for (const visibility of ["public", "private"] as const) {
      expect(
        getFolderPermissions({
          user: USER,
          userRoleIds: new Set(),
          folder: { roleId: "r1", visibility },
        }),
      ).toEqual({ canView: true, canEdit: false, isReadOnly: true });
    }
  });
});

import { getArticlePermissions } from "./permissions.js";

describe("getArticlePermissions(去 status)", () => {
  // 去掉草稿/归档三态后:可见性恒真(有 view 权限的人都能看),
  // canEdit = 目录可编辑 || 协作者 || 作者;isReadOnly = canView && !canEdit。
  const FOLDER_EDIT = { canView: true, canEdit: true, isReadOnly: false };
  const FOLDER_VIEW = { canView: true, canEdit: false, isReadOnly: true };
  const FOLDER_NONE = { canView: false, canEdit: false, isReadOnly: false };

  const AUTHOR_ID = "author-id";
  const OTHER_ID = "other-id";

  it("目录可编辑成员 → 可看可改", () => {
    const p = getArticlePermissions({
      folderPermissions: FOLDER_EDIT,
      article: { createdById: AUTHOR_ID },
      userId: OTHER_ID,
      isAdmin: false,
    });
    expect(p.canView).toBe(true);
    expect(p.canEdit).toBe(true);
    expect(p.isReadOnly).toBe(false);
  });

  it("非成员(目录只读)非作者非协作者 → 只读", () => {
    const p = getArticlePermissions({
      folderPermissions: FOLDER_VIEW,
      article: { createdById: AUTHOR_ID },
      userId: OTHER_ID,
      isAdmin: false,
    });
    expect(p.canView).toBe(true);
    expect(p.canEdit).toBe(false);
    expect(p.isReadOnly).toBe(true);
  });

  it("作者即使目录只读也可改", () => {
    const p = getArticlePermissions({
      folderPermissions: FOLDER_VIEW,
      article: { createdById: OTHER_ID },
      userId: OTHER_ID,
      isAdmin: false,
    });
    expect(p.canEdit).toBe(true);
    expect(p.isReadOnly).toBe(false);
  });

  it("作者(目录权限全无,被移出角色)仍可看可改自己的文档", () => {
    const p = getArticlePermissions({
      folderPermissions: FOLDER_NONE,
      article: { createdById: OTHER_ID },
      userId: OTHER_ID,
      isAdmin: false,
    });
    expect(p.canView).toBe(true);
    expect(p.canEdit).toBe(true);
  });

  it("协作者可看可改,但不可管理协作者", () => {
    const p = getArticlePermissions({
      folderPermissions: FOLDER_NONE,
      article: { createdById: AUTHOR_ID },
      userId: OTHER_ID,
      isAdmin: false,
      isCollaborator: true,
    });
    expect(p.canView).toBe(true);
    expect(p.canEdit).toBe(true);
    expect(p.canManageEditors).toBe(false);
  });

  it("作者 / 管理员可管理协作者", () => {
    expect(
      getArticlePermissions({
        folderPermissions: FOLDER_EDIT,
        article: { createdById: OTHER_ID },
        userId: OTHER_ID,
        isAdmin: false,
      }).canManageEditors,
    ).toBe(true);
    expect(
      getArticlePermissions({
        folderPermissions: FOLDER_EDIT,
        article: { createdById: AUTHOR_ID },
        userId: OTHER_ID,
        isAdmin: true,
      }).canManageEditors,
    ).toBe(true);
  });

  it("canBookmark/canCite/canExport 跟随 canView", () => {
    const r = getArticlePermissions({
      folderPermissions: FOLDER_VIEW,
      article: { createdById: AUTHOR_ID },
      userId: OTHER_ID,
      isAdmin: false,
    });
    expect(r.canBookmark).toBe(true);
    expect(r.canCite).toBe(true);
    expect(r.canExport).toBe(true);
  });
});
