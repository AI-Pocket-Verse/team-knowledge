import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedUser(ssoId: string) {
  return prisma.user.create({
    data: {
      ssoId,
      displayName: ssoId,
      },
  });
}

describe("POST /api/folders", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("admin can create a folder under any role", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "需求文档", visibility: "public", roleId: r.id, description: "desc" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.folder.name).toBe("需求文档");
    expect(body.folder.role.id).toBe(r.id);
    expect(body.folder.createdBy.displayName).toBe("Admin");
    expect(body.folder.permissions.canEdit).toBe(true);
    await app.close();
  });

  it("role member can create a folder under their own role", async () => {
    const u = await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "需求文档", visibility: "public", roleId: r.id },
    });
    expect(res.statusCode).toBe(201);
    // 文档目录没有私有范围：visibility:"private" 被拒绝并说明原因
    const priv = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "私有目录", visibility: "private", roleId: r.id },
    });
    expect(priv.statusCode).toBe(400);
    expect(priv.json().error).toBe("invalid_input");
    expect(priv.json().message).toContain("不支持私有");
    await app.close();
  });

  it("non-member: 403", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "设计" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "X", visibility: "public", roleId: r.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("409 on duplicate (roleId, name)", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.folder.create({ data: { name: "需求文档", roleId: r.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "需求文档", visibility: "public", roleId: r.id },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("allows re-creating a name held ONLY by a recycle-bin (soft-deleted) folder", async () => {
    const admin = await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    // Same name exists but is in the recycle bin (deletedAt set) → tree
    // doesn't show it, so it must not block re-creating the name.
    const dead = await prisma.folder.create({
      data: { name: "需求文档", roleId: r.id, visibility: "public", deletedAt: new Date(), deletedById: admin.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie: authCookie("admin") },
      payload: { name: "需求文档", visibility: "public", roleId: r.id },
    });
    expect(res.statusCode).toBe(201);
    // New LIVE folder took the name; the recycled one was renamed (still binned).
    const live = await prisma.folder.findFirst({ where: { roleId: r.id, name: "需求文档", deletedAt: null } });
    expect(live).not.toBeNull();
    const renamed = await prisma.folder.findUnique({ where: { id: dead.id } });
    expect(renamed?.name).not.toBe("需求文档");
    expect(renamed?.deletedAt).not.toBeNull();
    await app.close();
  });

  it("400 on invalid visibility", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "X", visibility: "secret", roleId: r.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404 on unknown roleId", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "X", visibility: "public", roleId: "nope" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /api/folders/:id", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("owner can rename + change visibility", async () => {
    const u = await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const m = await prisma.folder.create({
      data: { name: "旧名", roleId: r.id, visibility: "public", createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { name: "新名", visibility: "public" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder).toMatchObject({ name: "新名", visibility: "public" });
    const priv = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { visibility: "private" },
    });
    expect(priv.statusCode).toBe(400);
    await app.close();
  });

  it("non-admin sending roleId field: 403", async () => {
    const u = await seedUser("zhangsan");
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "设计" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r1.id } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r1.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { roleId: r2.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("admin can reassign roleId", async () => {
    await seedAdmin();
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "设计" } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r1.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { roleId: r2.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.role.id).toBe(r2.id);
    await app.close();
  });

  it("admin reassign roleId cascades to ALL child articles' roleId (incl. soft-deleted)", async () => {
    const admin = await seedAdmin();
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "设计" } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r1.id, visibility: "public" } });
    const liveChild = await prisma.article.create({ data: { title: "活", contentMarkdown: "x", folderId: m.id, roleId: r1.id, createdById: admin.id } });
    const deletedChild = await prisma.article.create({ data: { title: "删", contentMarkdown: "x", folderId: m.id, roleId: r1.id, createdById: admin.id, deletedAt: new Date(), deletedById: admin.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { roleId: r2.id },
    });
    expect(res.statusCode).toBe(200);
    // Both children — live AND soft-deleted — follow the folder to r2.
    expect((await prisma.article.findUnique({ where: { id: liveChild.id } }))?.roleId).toBe(r2.id);
    expect((await prisma.article.findUnique({ where: { id: deletedChild.id } }))?.roleId).toBe(r2.id);
    await app.close();
  });

  it("non-member: 403", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "服务端" } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { name: "Y" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("404 on missing id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/folders/nope",
      headers: { cookie },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409 when renaming to a name that already exists in the same role", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.folder.create({ data: { name: "已存在", roleId: r.id, visibility: "public" } });
    const m = await prisma.folder.create({ data: { name: "待改", roleId: r.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie },
      payload: { name: "已存在" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("renaming into a name held ONLY by a recycled folder frees the name (no 409)", async () => {
    const admin = await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    // Target name is held by a folder sitting in the recycle bin (invisible
    // in the tree) — renaming into it must succeed by freeing the binned
    // name, mirroring the create path, not 409 on an invisible folder.
    const dead = await prisma.folder.create({
      data: { name: "目标名", roleId: r.id, visibility: "public", deletedAt: new Date(), deletedById: admin.id },
    });
    const m = await prisma.folder.create({ data: { name: "待改", roleId: r.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/folders/${m.id}`,
      headers: { cookie: authCookie("admin") },
      payload: { name: "目标名" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.name).toBe("目标名");
    // The recycled folder was renamed away (still binned, still restorable).
    const renamed = await prisma.folder.findUnique({ where: { id: dead.id } });
    expect(renamed?.name).not.toBe("目标名");
    expect(renamed?.deletedAt).not.toBeNull();
    await app.close();
  });
});

describe("DELETE /api/folders/:id", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("owner can delete their own folder (soft-delete into the bin)", async () => {
    const u = await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "DELETE", url: `/api/folders/${m.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    // Soft-delete: the row survives with deletedAt/deletedById set, but
    // is gone from the role's folder listing.
    const after = await prisma.folder.findUnique({ where: { id: m.id } });
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedById).toBe(u.id);
    await app.close();
  });

  it("member: a folder holding another member's document cannot be deleted; admin can", async () => {
    const u = await seedUser("zhangsan");
    const other = await seedUser("lisi");
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const parent = await prisma.folder.create({ data: { name: "P", roleId: r.id, visibility: "public" } });
    const child = await prisma.folder.create({ data: { name: "C", roleId: r.id, visibility: "public", parentId: parent.id } });
    await prisma.article.create({ data: { title: "mine", contentMarkdown: "x", folderId: parent.id, roleId: r.id, createdById: u.id } });
    const theirs = await prisma.article.create({ data: { title: "theirs", contentMarkdown: "x", folderId: child.id, roleId: r.id, createdById: other.id } });
    const app = await buildServer(AUTH);

    const denied = await app.inject({ method: "DELETE", url: `/api/folders/${parent.id}`, headers: { cookie: authCookie("zhangsan") } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("folder_has_others_docs");
    expect((await prisma.article.findUnique({ where: { id: theirs.id } }))?.deletedAt).toBeNull();
    expect((await prisma.folder.findUnique({ where: { id: parent.id } }))?.deletedAt).toBeNull();

    // 作者已被删除(createdById 为空)的文档同样算「其他成员的」
    await prisma.article.update({ where: { id: theirs.id }, data: { createdById: null } });
    expect((await app.inject({ method: "DELETE", url: `/api/folders/${parent.id}`, headers: { cookie: authCookie("zhangsan") } })).statusCode).toBe(403);

    const ok = await app.inject({ method: "DELETE", url: `/api/folders/${parent.id}`, headers: { cookie: authCookie("admin") } });
    expect(ok.statusCode).toBe(204);
    expect((await prisma.article.findUnique({ where: { id: theirs.id } }))?.deletedAt).not.toBeNull();
    await app.close();
  });

  it("member can delete a folder that only holds their own documents", async () => {
    const u = await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r.id, visibility: "public" } });
    const a = await prisma.article.create({ data: { title: "mine", contentMarkdown: "x", folderId: m.id, roleId: r.id, createdById: u.id } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "DELETE", url: `/api/folders/${m.id}`, headers: { cookie: authCookie("zhangsan") } });
    expect(res.statusCode).toBe(204);
    expect((await prisma.article.findUnique({ where: { id: a.id } }))?.deletedById).toBe(u.id);
    await app.close();
  });

  it("non-member: 403", async () => {
    await seedUser("zhangsan");
    const r = await prisma.role.create({ data: { name: "设计" } });
    const m = await prisma.folder.create({ data: { name: "X", roleId: r.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "DELETE", url: `/api/folders/${m.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("404 on missing id", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({ method: "DELETE", url: "/api/folders/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("deleting a role cascades its folders", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.folder.create({ data: { name: "A", roleId: r.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "B", roleId: r.id, visibility: "private" } });
    await prisma.role.delete({ where: { id: r.id } });
    expect(await prisma.folder.findMany({ where: { roleId: r.id } })).toEqual([]);
  });
});

describe("POST /api/folders/reorder — completeness", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("rejects a partial id list (missing a live sibling) with 400 and leaves sortOrder untouched", async () => {
    const u = await seedUser("u");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const f1 = await prisma.folder.create({ data: { name: "A", roleId: r.id, visibility: "public", sortOrder: 0 } });
    const f2 = await prisma.folder.create({ data: { name: "B", roleId: r.id, visibility: "public", sortOrder: 1 } });
    const f3 = await prisma.folder.create({ data: { name: "C", roleId: r.id, visibility: "public", sortOrder: 2 } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");
    const res = await app.inject({
      method: "POST", url: "/api/folders/reorder", headers: { cookie },
      payload: { roleId: r.id, ids: [f2.id, f1.id] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("排序列表不完整");
    expect((await prisma.folder.findUnique({ where: { id: f3.id } }))?.sortOrder).toBe(2);
    await app.close();
  });

  it("accepts the complete id set and rewrites sortOrder to the submitted order", async () => {
    const u = await seedUser("u");
    const r = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    const f1 = await prisma.folder.create({ data: { name: "A", roleId: r.id, visibility: "public", sortOrder: 0 } });
    const f2 = await prisma.folder.create({ data: { name: "B", roleId: r.id, visibility: "public", sortOrder: 1 } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");
    const res = await app.inject({
      method: "POST", url: "/api/folders/reorder", headers: { cookie },
      payload: { roleId: r.id, ids: [f2.id, f1.id] },
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.folder.findUnique({ where: { id: f2.id } }))?.sortOrder).toBe(0);
    expect((await prisma.folder.findUnique({ where: { id: f1.id } }))?.sortOrder).toBe(1);
    await app.close();
  });
});

describe("folder nesting — create (2-level)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("creates a subfolder under a top-level folder", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const parent = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/folders", headers: { cookie },
      payload: { name: "历史版本", visibility: "public", roleId: role.id, parentId: parent.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().folder.parentId).toBe(parent.id);
    await app.close();
  });

  it("rejects a folder nested under a subfolder (depth cap = 2)", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const top = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "历史", roleId: role.id, parentId: top.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/folders", headers: { cookie },
      payload: { name: "更深", visibility: "public", roleId: role.id, parentId: sub.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a parent in a different role", async () => {
    await seedAdmin();
    const roleA = await prisma.role.create({ data: { name: "A" } });
    const roleB = await prisma.role.create({ data: { name: "B" } });
    const parent = await prisma.folder.create({ data: { name: "p", roleId: roleA.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/folders", headers: { cookie },
      payload: { name: "x", visibility: "public", roleId: roleB.id, parentId: parent.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("same name allowed under different parents, rejected under the same parent", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const b = await prisma.folder.create({ data: { name: "设计稿", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const mk = (parentId: string) => app.inject({
      method: "POST", url: "/api/folders", headers: { cookie },
      payload: { name: "历史版本", visibility: "public", roleId: role.id, parentId },
    });
    expect((await mk(a.id)).statusCode).toBe(201); // under 需求池
    expect((await mk(b.id)).statusCode).toBe(201); // under 设计稿 — different parent, OK
    expect((await mk(a.id)).statusCode).toBe(409); // 需求池 again — same parent, conflict
    await app.close();
  });
});

describe("folder nesting — PATCH cross-role subtree cascade", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("cross-role reassign cascades roleId to subfolders and all subtree articles", async () => {
    await seedAdmin();
    const roleA = await prisma.role.create({ data: { name: "A角色" } });
    const roleB = await prisma.role.create({ data: { name: "B角色" } });
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: roleA.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: roleA.id, parentId: top.id, visibility: "public" } });
    const docTop = await prisma.article.create({ data: { title: "t", contentMarkdown: "x", roleId: roleA.id, folderId: top.id } });
    const docSub = await prisma.article.create({ data: { title: "s", contentMarkdown: "y", roleId: roleA.id, folderId: sub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${top.id}`, headers: { cookie },
      payload: { roleId: roleB.id },
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.folder.findUnique({ where: { id: sub.id } }))?.roleId).toBe(roleB.id);
    expect((await prisma.article.findUnique({ where: { id: docTop.id } }))?.roleId).toBe(roleB.id);
    expect((await prisma.article.findUnique({ where: { id: docSub.id } }))?.roleId).toBe(roleB.id);
    await app.close();
  });
});

describe("folder nesting — reorder per-parent", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("reorders subfolders within a parent only (per-parent completeness)", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const s1 = await prisma.folder.create({ data: { name: "s1", roleId: role.id, parentId: top.id, visibility: "public", sortOrder: 0 } });
    const s2 = await prisma.folder.create({ data: { name: "s2", roleId: role.id, parentId: top.id, visibility: "public", sortOrder: 1 } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // Complete submission of this parent's two subfolders in a new order.
    const ok = await app.inject({
      method: "POST", url: "/api/folders/reorder", headers: { cookie },
      payload: { roleId: role.id, parentId: top.id, ids: [s2.id, s1.id] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.folder.findUnique({ where: { id: s2.id } }))?.sortOrder).toBe(0);
    // Partial list (only one of the two siblings) → 400 incomplete.
    const bad = await app.inject({
      method: "POST", url: "/api/folders/reorder", headers: { cookie },
      payload: { roleId: role.id, parentId: top.id, ids: [s1.id] },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("top-level reorder is unaffected by the presence of subfolders", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const t1 = await prisma.folder.create({ data: { name: "t1", roleId: role.id, visibility: "public", sortOrder: 0 } });
    const t2 = await prisma.folder.create({ data: { name: "t2", roleId: role.id, visibility: "public", sortOrder: 1 } });
    // a subfolder under t1 must NOT be required in the top-level reorder set.
    await prisma.folder.create({ data: { name: "sub", roleId: role.id, parentId: t1.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "POST", url: "/api/folders/reorder", headers: { cookie },
      payload: { roleId: role.id, ids: [t2.id, t1.id] }, // top-level only (parentId omitted = null)
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.folder.findUnique({ where: { id: t2.id } }))?.sortOrder).toBe(0);
    await app.close();
  });
});

describe("folder nesting — soft-delete cascade", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("soft-deleting a top-level folder cascades subfolders + subtree docs with one shared deletedAt", async () => {
    const u = await seedUser("zhangsan");
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: role.id, parentId: top.id, visibility: "public" } });
    const dTop = await prisma.article.create({ data: { title: "顶层文档", contentMarkdown: "x", roleId: role.id, createdById: u.id, folderId: top.id } });
    const dSub = await prisma.article.create({ data: { title: "子文档", contentMarkdown: "y", roleId: role.id, createdById: u.id, folderId: sub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    const res = await app.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    const [fTop, fSub, aTop, aSub] = await Promise.all([
      prisma.folder.findUnique({ where: { id: top.id } }),
      prisma.folder.findUnique({ where: { id: sub.id } }),
      prisma.article.findUnique({ where: { id: dTop.id } }),
      prisma.article.findUnique({ where: { id: dSub.id } }),
    ]);
    const ts = fTop!.deletedAt!.getTime();
    expect(fSub!.deletedAt!.getTime()).toBe(ts);
    expect(aTop!.deletedAt!.getTime()).toBe(ts);
    expect(aSub!.deletedAt!.getTime()).toBe(ts);
    await app.close();
  });
});

describe("folder nesting — reparent via PATCH", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("nests a childless top-level folder under another top-level folder", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const target = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const moved = await prisma.folder.create({ data: { name: "历史版本", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${moved.id}`, headers: { cookie },
      payload: { parentId: target.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.parentId).toBe(target.id);
    await app.close();
  });

  it("promotes a subfolder back to top-level (parentId=null)", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const top = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "历史版本", roleId: role.id, parentId: top.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${sub.id}`, headers: { cookie },
      payload: { parentId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.parentId).toBeNull();
    await app.close();
  });

  it("rejects nesting a folder that itself has subfolders", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const target = await prisma.folder.create({ data: { name: "目标", roleId: role.id, visibility: "public" } });
    const parent = await prisma.folder.create({ data: { name: "有子", roleId: role.id, visibility: "public" } });
    await prisma.folder.create({ data: { name: "子", roleId: role.id, parentId: parent.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${parent.id}`, headers: { cookie },
      payload: { parentId: target.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects nesting under a subfolder (depth cap = 2)", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: role.id, parentId: top.id, visibility: "public" } });
    const moved = await prisma.folder.create({ data: { name: "待移动", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${moved.id}`, headers: { cookie },
      payload: { parentId: sub.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects nesting a folder into itself", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const f = await prisma.folder.create({ data: { name: "自己", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${f.id}`, headers: { cookie },
      payload: { parentId: f.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("409 when the target group already has a live folder with the same name", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const target = await prisma.folder.create({ data: { name: "目标", roleId: role.id, visibility: "public" } });
    // A live subfolder named 历史版本 already under target.
    await prisma.folder.create({ data: { name: "历史版本", roleId: role.id, parentId: target.id, visibility: "public" } });
    // A top-level folder of the same name we try to nest under target.
    const moved = await prisma.folder.create({ data: { name: "历史版本", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${moved.id}`, headers: { cookie },
      payload: { parentId: target.id },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("cross-role move of a subfolder auto-promotes it to top-level in the new role", async () => {
    await seedAdmin();
    const roleA = await prisma.role.create({ data: { name: "A角色" } });
    const roleB = await prisma.role.create({ data: { name: "B角色" } });
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: roleA.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: roleA.id, parentId: top.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "PATCH", url: `/api/folders/${sub.id}`, headers: { cookie },
      payload: { roleId: roleB.id },
    });
    expect(res.statusCode).toBe(200);
    const moved = await prisma.folder.findUnique({ where: { id: sub.id } });
    expect(moved!.roleId).toBe(roleB.id);
    expect(moved!.parentId).toBeNull(); // promoted — not left dangling under a role-A parent
    await app.close();
  });
});

describe("同角色同名顶层目录并发创建", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("并发 5 个同名顶层目录:恰好 1 个 201,其余 409,库里只有 1 个", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/folders",
          headers: { cookie },
          payload: { name: "并发目录", visibility: "public", roleId: r.id },
        }),
      ),
    );
    const codes = results.map((x) => x.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
    expect(await prisma.folder.count({ where: { roleId: r.id, name: "并发目录" } })).toBe(1);
    await app.close();
  });

  it("并发把两个目录改成同一个名字:只有 1 个成功,其余 409", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const a = await prisma.folder.create({ data: { id: "fa", name: "甲", roleId: r.id, visibility: "public" } });
    const b = await prisma.folder.create({ data: { id: "fb", name: "乙", roleId: r.id, visibility: "public" } });
    const results = await Promise.all(
      [a, b].map((f) =>
        app.inject({ method: "PATCH", url: `/api/folders/${f.id}`, headers: { cookie }, payload: { name: "同名" } }),
      ),
    );
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.folder.count({ where: { roleId: r.id, name: "同名" } })).toBe(1);
    await app.close();
  });

  it("目录名全空格返回 400", async () => {
    await seedAdmin();
    const r = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie: authCookie("admin") },
      payload: { name: "   ", visibility: "public", roleId: r.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    await app.close();
  });
});
