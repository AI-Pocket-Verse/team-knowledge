import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// A role the seeded user belongs to (so they can create/delete under it).
async function seedRoleFor(userId: string, name = "产品") {
  const role = await prisma.role.create({ data: { name, color: "#8b5cf6" } });
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
  return role;
}

describe("recycle bin — articles", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("soft-deleted article: gone from listings, appears in the deleter's bin, restorable, then permanently deletable", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const fold = await prisma.folder.create({ data: { name: "需求池", roleId: role.id, visibility: "public" } });
    const a = await prisma.article.create({
      data: { title: "草稿", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    // Delete → 204
    const del = await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);

    // Gone from the folder's article listing.
    const list = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect((list.json().articles as { id: string }[]).some((x) => x.id === a.id)).toBe(false);

    // Appears in the deleter's bin as an article entry.
    const bin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    expect(bin.statusCode).toBe(200);
    const items = bin.json().items as Array<{ type: string; id: string; folderName: string | null }>;
    const entry = items.find((x) => x.type === "article" && x.id === a.id);
    expect(entry).toBeTruthy();
    expect(entry?.folderName).toBe("需求池");

    // Restore → back in the listing.
    const restore = await app.inject({ method: "POST", url: `/api/recycle-bin/article/${a.id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(204);
    const list2 = await app.inject({ method: "GET", url: `/api/folders/${fold.id}/articles`, headers: { cookie } });
    expect((list2.json().articles as { id: string }[]).some((x) => x.id === a.id)).toBe(true);

    // Delete again, then permanent-delete from the bin → row gone.
    await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie } });
    const purge = await app.inject({ method: "DELETE", url: `/api/recycle-bin/article/${a.id}`, headers: { cookie } });
    expect(purge.statusCode).toBe(204);
    expect(await prisma.article.findUnique({ where: { id: a.id } })).toBeNull();
  });

  it("bin is private: a second user does NOT see another user's deleted article", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const a = await prisma.article.create({
      data: { title: "私有删除", contentMarkdown: "x", roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("u") } });

    // Another non-admin user with no relation to the doc.
    await seedUser({ ssoId: "other" });
    const otherBin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie: authCookie("other") } });
    expect((otherBin.json().items as { id: string }[]).some((x) => x.id === a.id)).toBe(false);

    // The deleter still sees it.
    const myBin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie: authCookie("u") } });
    expect((myBin.json().items as { id: string }[]).some((x) => x.id === a.id)).toBe(true);
  });

  it("admin even cannot see another user's items in their OWN bin (bin stays personal)", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const a = await prisma.article.create({
      data: { title: "他人删除", contentMarkdown: "x", roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie: authCookie("u") } });

    await seedAdmin();
    const adminBin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie: authCookie("admin") } });
    expect((adminBin.json().items as { id: string }[]).some((x) => x.id === a.id)).toBe(false);
  });

  it("restoring an article whose folder is still binned detaches it to role-direct", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const fold = await prisma.folder.create({ data: { name: "F", roleId: role.id, visibility: "public" } });
    const a = await prisma.article.create({
      data: { title: "孤儿候选", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    // Delete the article individually first, then delete its folder
    // (different deletedAt). Now restore the article alone.
    await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie } });
    await app.inject({ method: "DELETE", url: `/api/folders/${fold.id}`, headers: { cookie } });

    const restore = await app.inject({ method: "POST", url: `/api/recycle-bin/article/${a.id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(204);
    const reread = await prisma.article.findUnique({ where: { id: a.id } });
    expect(reread?.deletedAt).toBeNull();
    expect(reread?.folderId).toBeNull(); // detached from the still-binned folder
  });
});

describe("recycle bin — folder cascade", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("folder delete bins folder + its docs together; restore restores both; an individually-deleted doc inside is NOT restored by folder-restore", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const fold = await prisma.folder.create({ data: { name: "团队", roleId: role.id, visibility: "public" } });
    const child1 = await prisma.article.create({
      data: { title: "随目录", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const child2 = await prisma.article.create({
      data: { title: "也随目录", contentMarkdown: "y", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const soloDeleted = await prisma.article.create({
      data: { title: "先单独删", contentMarkdown: "z", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    // Delete one child INDIVIDUALLY first (its own deletedAt instant).
    await app.inject({ method: "DELETE", url: `/api/articles/${soloDeleted.id}`, headers: { cookie } });
    // Now delete the folder → folder + the two remaining live children share one deletedAt.
    const delFold = await app.inject({ method: "DELETE", url: `/api/folders/${fold.id}`, headers: { cookie } });
    expect(delFold.statusCode).toBe(204);

    // Bin shows the FOLDER entry with docCount=2 (the two cascaded kids),
    // NOT the cascaded kids individually, but DOES show the solo-deleted doc.
    const bin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    const items = bin.json().items as Array<{ type: string; id: string; docCount?: number }>;
    const folderEntry = items.find((x) => x.type === "folder" && x.id === fold.id);
    expect(folderEntry?.docCount).toBe(2);
    expect(items.some((x) => x.type === "article" && x.id === child1.id)).toBe(false);
    expect(items.some((x) => x.type === "article" && x.id === child2.id)).toBe(false);
    expect(items.some((x) => x.type === "article" && x.id === soloDeleted.id)).toBe(true);

    // Restore the folder → folder + its two cascaded kids come back; the
    // individually-deleted doc stays in the bin.
    const restore = await app.inject({ method: "POST", url: `/api/recycle-bin/folder/${fold.id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(204);
    expect((await prisma.folder.findUnique({ where: { id: fold.id } }))?.deletedAt).toBeNull();
    expect((await prisma.article.findUnique({ where: { id: child1.id } }))?.deletedAt).toBeNull();
    expect((await prisma.article.findUnique({ where: { id: child2.id } }))?.deletedAt).toBeNull();
    expect((await prisma.article.findUnique({ where: { id: soloDeleted.id } }))?.deletedAt).not.toBeNull();
  });

  it("interleaving: delete child individually → delete folder → purge folder; the solo child stays consistent (role-direct) and restorable", async () => {
    // Reproduces the grouping-inconsistency bug. A child binned on its own
    // (deletedAt = T1) keeps folderId=F. When folder F is then binned
    // (deletedAt = T2 ≠ T1) and later PERMANENTLY purged, the solo child
    // must NOT dangle the (now-gone) folder's name — it should read as a
    // role-direct binned item and restore as role-direct.
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const fold = await prisma.folder.create({ data: { name: "交错", roleId: role.id, visibility: "public" } });
    const solo = await prisma.article.create({
      data: { title: "先单独删的孩子", contentMarkdown: "z", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    // 1) Delete the child individually (its own deletedAt instant).
    await app.inject({ method: "DELETE", url: `/api/articles/${solo.id}`, headers: { cookie } });

    // While the folder is still LIVE, the bin shows the solo child WITH its
    // folder name (the folder is a real, viewable container).
    const binBefore = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    const beforeEntry = (binBefore.json().items as Array<{ type: string; id: string; folderName: string | null }>)
      .find((x) => x.type === "article" && x.id === solo.id);
    expect(beforeEntry?.folderName).toBe("交错");

    // 2) Bin the folder (different deletedAt).
    await app.inject({ method: "DELETE", url: `/api/folders/${fold.id}`, headers: { cookie } });

    // Now the folder is itself in the bin (separate deletedAt) → the solo
    // child must read as role-direct (folderName null), not dangle the
    // binned folder's name. Still shown individually (not part of the
    // folder's cascade).
    const binMid = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    const midItems = binMid.json().items as Array<{ type: string; id: string; folderName: string | null }>;
    const midEntry = midItems.find((x) => x.type === "article" && x.id === solo.id);
    expect(midEntry).toBeTruthy();
    expect(midEntry?.folderName).toBeNull();

    // 3) Permanently purge the folder. The solo child is NOT part of the
    // cascade (different deletedAt) → it must survive, detached to role-direct.
    const purge = await app.inject({ method: "DELETE", url: `/api/recycle-bin/folder/${fold.id}`, headers: { cookie } });
    expect(purge.statusCode).toBe(204);
    expect(await prisma.folder.findUnique({ where: { id: fold.id } })).toBeNull();

    const afterRow = await prisma.article.findUnique({ where: { id: solo.id } });
    expect(afterRow).not.toBeNull();
    expect(afterRow?.deletedAt).not.toBeNull(); // still binned
    expect(afterRow?.folderId).toBeNull(); // explicitly detached to role-direct

    // Bin still lists the solo child as a role-direct article entry.
    const binAfter = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    const afterEntry = (binAfter.json().items as Array<{ type: string; id: string; folderName: string | null }>)
      .find((x) => x.type === "article" && x.id === solo.id);
    expect(afterEntry).toBeTruthy();
    expect(afterEntry?.folderName).toBeNull();

    // 4) Still restorable — comes back as a live role-direct doc.
    const restore = await app.inject({ method: "POST", url: `/api/recycle-bin/article/${solo.id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(204);
    const restored = await prisma.article.findUnique({ where: { id: solo.id } });
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.folderId).toBeNull();
  });

  it("permanent-delete a binned folder hard-removes its co-deleted child docs", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const fold = await prisma.folder.create({ data: { name: "永久删", roleId: role.id, visibility: "public" } });
    const kid = await prisma.article.create({
      data: { title: "随之消失", contentMarkdown: "x", folderId: fold.id, roleId: role.id, createdById: u.id },
    });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");
    await app.inject({ method: "DELETE", url: `/api/folders/${fold.id}`, headers: { cookie } });

    const purge = await app.inject({ method: "DELETE", url: `/api/recycle-bin/folder/${fold.id}`, headers: { cookie } });
    expect(purge.statusCode).toBe(204);
    expect(await prisma.folder.findUnique({ where: { id: fold.id } })).toBeNull();
    expect(await prisma.article.findUnique({ where: { id: kid.id } })).toBeNull();
  });

  it("restoring a folder after its name was re-used by a new live folder still succeeds (204) and stays restorable", async () => {
    // Realistic re-take flow: bin "团队空间", then create a NEW folder with
    // the same name via the route. The create handler frees the recycled
    // name by suffixing the BINNED folder (folders.ts), so the new live
    // folder takes "团队空间" cleanly. Restoring the (now-suffixed) binned
    // folder must succeed with no 500 and bring it back live. Restore flattens
    // every folder to top-level (parentId=null) and picks a free name among LIVE
    // top-level siblings via freeTopLevelName — so it can never wedge the folder
    // in the bin. (SQLite doesn't enforce the unique index for NULL parentId, so
    // there is no P2002 to catch on the top-level restore path.)
    const u = await seedUser({ ssoId: "u" });
    const role = await seedRoleFor(u.id);
    const fold = await prisma.folder.create({ data: { name: "团队空间", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    await app.inject({ method: "DELETE", url: `/api/folders/${fold.id}`, headers: { cookie } });
    // Re-create the same name → route renames the binned folder out of the way.
    const recreate = await app.inject({
      method: "POST", url: "/api/folders", headers: { cookie },
      payload: { name: "团队空间", visibility: "public", roleId: role.id },
    });
    expect(recreate.statusCode).toBe(201);

    // Restore the original (binned) folder — must not 500.
    const restore = await app.inject({ method: "POST", url: `/api/recycle-bin/folder/${fold.id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(204);
    const restored = await prisma.folder.findUnique({ where: { id: fold.id } });
    expect(restored?.deletedAt).toBeNull();
    // Two live folders now coexist under the role (the recreated one + the
    // restored one under its freed/suffixed name) — both with distinct names.
    const live = await prisma.folder.findMany({ where: { roleId: role.id, deletedAt: null } });
    expect(live).toHaveLength(2);
    expect(new Set(live.map((f) => f.name)).size).toBe(2);
  });
});

describe("recycle bin — meetings", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  // Create an already-ended meeting owned by `ssoId`, returning its id.
  async function seedEndedMeeting(app: Awaited<ReturnType<typeof buildServer>>, ssoId: string) {
    const cookie = authCookie(ssoId);
    const c = await app.inject({
      method: "POST", url: "/api/meeting", headers: { cookie },
      payload: { title: "可删会议", allowedRoleIds: [], config: {} },
    });
    const id = c.json().session.id as string;
    await app.inject({ method: "DELETE", url: `/api/meeting/${id}`, headers: { cookie } });
    return id;
  }

  it("creator soft-deletes their ended meeting → it lands in their bin, restorable", async () => {
    await seedUser({ ssoId: "host" });
    const app = await buildServer(AUTH);
    const cookie = authCookie("host");
    const id = await seedEndedMeeting(app, "host");

    // Soft-delete via /:id/hard (now soft) by the creator.
    const del = await app.inject({ method: "DELETE", url: `/api/meeting/${id}/hard`, headers: { cookie } });
    expect(del.statusCode).toBe(204);

    // In the creator's bin as a meeting entry; gone from the hub.
    const bin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    expect((bin.json().items as { type: string; id: string }[]).some((x) => x.type === "meeting" && x.id === id)).toBe(true);
    const hub = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie } });
    expect((hub.json().recent as { id: string }[]).some((m) => m.id === id)).toBe(false);

    // Restore → back on the hub, out of the bin.
    const restore = await app.inject({ method: "POST", url: `/api/recycle-bin/meeting/${id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(204);
    const hub2 = await app.inject({ method: "GET", url: "/api/meeting/hub", headers: { cookie } });
    expect((hub2.json().recent as { id: string }[]).some((m) => m.id === id)).toBe(true);
  });

  it("permanent-delete a binned meeting removes the row", async () => {
    await seedUser({ ssoId: "host" });
    const app = await buildServer(AUTH);
    const cookie = authCookie("host");
    const id = await seedEndedMeeting(app, "host");
    await app.inject({ method: "DELETE", url: `/api/meeting/${id}/hard`, headers: { cookie } });

    const purge = await app.inject({ method: "DELETE", url: `/api/recycle-bin/meeting/${id}`, headers: { cookie } });
    expect(purge.statusCode).toBe(204);
    expect(await prisma.meetingSession.findUnique({ where: { id } })).toBeNull();
  });

  it("another user cannot restore a meeting they didn't delete (403)", async () => {
    await seedUser({ ssoId: "host" });
    await seedUser({ ssoId: "other" });
    const app = await buildServer(AUTH);
    const id = await seedEndedMeeting(app, "host");
    await app.inject({ method: "DELETE", url: `/api/meeting/${id}/hard`, headers: { cookie: authCookie("host") } });

    const r = await app.inject({ method: "POST", url: `/api/recycle-bin/meeting/${id}/restore`, headers: { cookie: authCookie("other") } });
    expect(r.statusCode).toBe(403);
  });
});

describe("recycle bin — nested folder subtree", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("a deleted top-level folder with a subfolder shows ONE root entry; docCount counts the whole subtree", async () => {
    const u = await seedUser({ ssoId: "zhangsan" });
    const role = await seedRoleFor(u.id);
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: role.id, parentId: top.id, visibility: "public" } });
    await prisma.article.create({ data: { title: "顶层文档", contentMarkdown: "x", roleId: role.id, createdById: u.id, folderId: top.id } });
    await prisma.article.create({ data: { title: "子文档", contentMarkdown: "y", roleId: role.id, createdById: u.id, folderId: sub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    await app.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: { cookie } });
    const bin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie } });
    const items = bin.json().items as Array<{ type: string; id: string; docCount?: number }>;
    const folderEntries = items.filter((x) => x.type === "folder");
    expect(folderEntries).toHaveLength(1);              // only the root (top), subfolder hidden
    expect(folderEntries[0].id).toBe(top.id);
    expect(folderEntries[0].docCount).toBe(2);          // top doc + sub doc
    await app.close();
  });

  it("restoring a folder subtree flattens every folder to top-level; docs stay in their folders", async () => {
    const u = await seedUser({ ssoId: "zhangsan" });
    const role = await seedRoleFor(u.id);
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: role.id, parentId: top.id, visibility: "public" } });
    const dSub = await prisma.article.create({ data: { title: "子文档", contentMarkdown: "y", roleId: role.id, createdById: u.id, folderId: sub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    await app.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: { cookie } });
    const r = await app.inject({ method: "POST", url: `/api/recycle-bin/folder/${top.id}/restore`, headers: { cookie } });
    expect(r.statusCode).toBe(204);
    const [fTop, fSub, aSub] = await Promise.all([
      prisma.folder.findUnique({ where: { id: top.id } }),
      prisma.folder.findUnique({ where: { id: sub.id } }),
      prisma.article.findUnique({ where: { id: dSub.id } }),
    ]);
    expect(fTop!.deletedAt).toBeNull();
    expect(fTop!.parentId).toBeNull();
    expect(fSub!.deletedAt).toBeNull();
    expect(fSub!.parentId).toBeNull();          // subfolder flattened to top-level
    expect(aSub!.deletedAt).toBeNull();
    expect(aSub!.folderId).toBe(sub.id);        // doc stays in its (now top-level) folder
    await app.close();
  });

  it("a flattened subfolder auto-renames when its name collides with a live top-level folder", async () => {
    const u = await seedUser({ ssoId: "zhangsan" });
    const role = await seedRoleFor(u.id);
    const parent = await prisma.folder.create({ data: { name: "父", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "历史版本", roleId: role.id, parentId: parent.id, visibility: "public" } });
    // A live top-level folder with the SAME name (allowed — different parent).
    await prisma.folder.create({ data: { name: "历史版本", roleId: role.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    await app.inject({ method: "DELETE", url: `/api/folders/${parent.id}`, headers: { cookie } });
    const r = await app.inject({ method: "POST", url: `/api/recycle-bin/folder/${parent.id}/restore`, headers: { cookie } });
    expect(r.statusCode).toBe(204);
    const restoredSub = await prisma.folder.findUnique({ where: { id: sub.id } });
    expect(restoredSub!.deletedAt).toBeNull();
    expect(restoredSub!.parentId).toBeNull();        // flattened
    expect(restoredSub!.name).not.toBe("历史版本");   // auto-renamed to avoid the live top-level clash
    await app.close();
  });

  it("purging a top-level folder hard-deletes the co-deleted subtree but keeps a separately-binned subfolder as a top-level bin item", async () => {
    const u = await seedUser({ ssoId: "zhangsan" });
    const role = await seedRoleFor(u.id);
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const coSub = await prisma.folder.create({ data: { name: "随删子", roleId: role.id, parentId: top.id, visibility: "public" } });
    const soloSub = await prisma.folder.create({ data: { name: "单独删子", roleId: role.id, parentId: top.id, visibility: "public" } });
    const dCo = await prisma.article.create({ data: { title: "随删文档", contentMarkdown: "x", roleId: role.id, createdById: u.id, folderId: coSub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    // Delete soloSub first (its own timestamp), then top (cascades coSub + its doc, NOT soloSub).
    await app.inject({ method: "DELETE", url: `/api/folders/${soloSub.id}`, headers: { cookie } });
    await app.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: { cookie } });
    const purge = await app.inject({ method: "DELETE", url: `/api/recycle-bin/folder/${top.id}`, headers: { cookie } });
    expect(purge.statusCode).toBe(204);
    expect(await prisma.folder.findUnique({ where: { id: top.id } })).toBeNull();
    expect(await prisma.folder.findUnique({ where: { id: coSub.id } })).toBeNull();   // co-deleted subfolder hard-deleted
    expect(await prisma.article.findUnique({ where: { id: dCo.id } })).toBeNull();    // co-deleted doc hard-deleted
    const survivor = await prisma.folder.findUnique({ where: { id: soloSub.id } });
    expect(survivor).not.toBeNull();                 // separately-binned subfolder survives
    expect(survivor!.parentId).toBeNull();           // promoted to top-level (parent was purged)
    expect(survivor!.deletedAt).not.toBeNull();      // still in the bin, restorable
    await app.close();
  });

  it("restoring a folder whose subfolder shares its name keeps the ROOT's clean name (subfolder gets the suffix)", async () => {
    const u = await seedUser({ ssoId: "zhangsan" });
    const role = await seedRoleFor(u.id);
    // Top-level "档案" with a subfolder also named "档案" (allowed — different parent).
    const top = await prisma.folder.create({ data: { name: "档案", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "档案", roleId: role.id, parentId: top.id, visibility: "public" } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    await app.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: { cookie } });
    const r = await app.inject({ method: "POST", url: `/api/recycle-bin/folder/${top.id}/restore`, headers: { cookie } });
    expect(r.statusCode).toBe(204);
    const [restoredTop, restoredSub] = await Promise.all([
      prisma.folder.findUnique({ where: { id: top.id } }),
      prisma.folder.findUnique({ where: { id: sub.id } }),
    ]);
    expect(restoredTop!.name).toBe("档案");          // root keeps its name
    expect(restoredSub!.name).not.toBe("档案");       // colliding subfolder takes the suffix
    expect(restoredTop!.parentId).toBeNull();
    expect(restoredSub!.parentId).toBeNull();         // both flattened to top-level
    await app.close();
  });

  it("purging a top-level folder keeps a separately-binned doc that lived in a co-deleted subfolder (detached to role-direct)", async () => {
    const user = await seedUser({ ssoId: "zhangsan" });
    const role = await seedRoleFor(user.id);
    const top = await prisma.folder.create({ data: { name: "顶层", roleId: role.id, visibility: "public" } });
    const sub = await prisma.folder.create({ data: { name: "子", roleId: role.id, parentId: top.id, visibility: "public" } });
    const solo = await prisma.article.create({ data: { title: "先单独删的文档", contentMarkdown: "z", roleId: role.id, createdById: user.id, folderId: sub.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("zhangsan");
    // The doc was binned EARLIER under its own (distinct) timestamp — stamp it
    // directly so it can't collide with the folder-delete instant the test
    // triggers next (subtree grouping keys off exact deletedAt equality).
    await prisma.article.update({
      where: { id: solo.id },
      data: { deletedAt: new Date(Date.now() - 60_000), deletedById: user.id },
    });
    // Now delete the top folder (cascades the subfolder, but NOT the already-
    // binned doc — its timestamp differs).
    await app.inject({ method: "DELETE", url: `/api/folders/${top.id}`, headers: { cookie } });
    // Purge the top folder permanently.
    const purge = await app.inject({ method: "DELETE", url: `/api/recycle-bin/folder/${top.id}`, headers: { cookie } });
    expect(purge.statusCode).toBe(204);
    const doc = await prisma.article.findUnique({ where: { id: solo.id } });
    expect(doc).not.toBeNull();          // separately-binned doc survives the purge
    expect(doc!.folderId).toBeNull();    // detached to role-direct (its folder was hard-deleted)
    expect(doc!.deletedAt).not.toBeNull(); // still in the bin, restorable
    await app.close();
  });
});

describe("recycle bin — 一键清空(DELETE /api/recycle-bin)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("清空本人全部回收项(文档+目录级联);别人的回收项不受影响且被摘挂保活", async () => {
    const u = await seedUser({ ssoId: "u" });
    const other = await seedUser({ ssoId: "other" });
    const role = await seedRoleFor(u.id);
    await prisma.userRole.create({ data: { userId: other.id, roleId: role.id } });

    // u:一篇散文档 + 一个含文档的目录,全部删进回收站。
    const solo = await prisma.article.create({
      data: { title: "散文档", contentMarkdown: "x", roleId: role.id, createdById: u.id },
    });
    const fold = await prisma.folder.create({ data: { name: "U的目录", roleId: role.id, visibility: "public" } });
    const inFold = await prisma.article.create({
      data: { title: "目录内", contentMarkdown: "x", roleId: role.id, folderId: fold.id, createdById: u.id },
    });
    // other:先把自己的文档(挂在 u 的目录下)单独删进回收站。
    const othersDoc = await prisma.article.create({
      data: { title: "别人的", contentMarkdown: "x", roleId: role.id, folderId: fold.id, createdById: other.id },
    });
    const app = await buildServer(AUTH);
    await app.inject({ method: "DELETE", url: `/api/articles/${othersDoc.id}`, headers: { cookie: authCookie("other") } });
    await app.inject({ method: "DELETE", url: `/api/articles/${solo.id}`, headers: { cookie: authCookie("u") } });
    await app.inject({ method: "DELETE", url: `/api/folders/${fold.id}`, headers: { cookie: authCookie("u") } });

    // u 一键清空 → 自己的两个回收项(散文档 + 目录[含1篇])全部硬删。
    const r = await app.inject({ method: "DELETE", url: "/api/recycle-bin", headers: { cookie: authCookie("u") } });
    expect(r.statusCode).toBe(200);
    expect(r.json().purged).toMatchObject({ articles: 2, folders: 1, meetings: 0 });

    // u 的回收站空了;数据真没了。
    const bin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie: authCookie("u") } });
    expect(bin.json().items).toHaveLength(0);
    expect(await prisma.article.findUnique({ where: { id: solo.id } })).toBeNull();
    expect(await prisma.article.findUnique({ where: { id: inFold.id } })).toBeNull();
    expect(await prisma.folder.findUnique({ where: { id: fold.id } })).toBeNull();

    // other 的回收项保留:仍在他的回收站,且已摘到角色直挂(容器没了)。
    const kept = await prisma.article.findUnique({ where: { id: othersDoc.id } });
    expect(kept).not.toBeNull();
    expect(kept!.deletedAt).not.toBeNull();
    expect(kept!.folderId).toBeNull();
    const otherBin = await app.inject({ method: "GET", url: "/api/recycle-bin", headers: { cookie: authCookie("other") } });
    expect((otherBin.json().items as Array<{ id: string }>).some((x) => x.id === othersDoc.id)).toBe(true);

    // 空回收站再清一次:幂等,全 0。
    const r2 = await app.inject({ method: "DELETE", url: "/api/recycle-bin", headers: { cookie: authCookie("u") } });
    expect(r2.json().purged).toEqual({ articles: 0, folders: 0, meetings: 0 });
    await app.close();
  });
});
