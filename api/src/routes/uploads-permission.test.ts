// Regression tests for the Upload permission gate added alongside the
// Upload table. The gate enforces: filenames not in the Upload table 404
// for non-admins; unbound uploads are uploader-only; once bound to an
// article the upload inherits that article's getArticlePermissions.canView.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { env } from "../env.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

const UPLOAD_DIR = resolve(env.DATA_DIR, "uploads");
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

async function uploadAsCookie(app: Awaited<ReturnType<typeof buildServer>>, cookie: string): Promise<string> {
  const boundary = "----PB";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="t.png"\r\n`),
    Buffer.from(`Content-Type: image/png\r\n\r\n`),
    PNG_BYTES,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/uploads/image",
    headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().url as string; // "/uploads/abc.png"
}

async function seedUser(ssoId: string, opts: { admin?: boolean } = {}) {
  return prisma.user.create({
    data: {
      ssoId,
      displayName: ssoId.toUpperCase(),
      isAdmin: !!opts.admin,
    },
  });
}

async function seedRoleAndFolder(visibility: "public" | "private" = "public") {
  const role = await prisma.role.create({ data: { name: `r-${Date.now()}-${Math.random()}` } });
  const mod = await prisma.folder.create({
    data: { name: "m1", roleId: role.id, visibility, templateType: "article-list" },
  });
  return { role, mod };
}

describe("Upload permission gate", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("POST upload creates an Upload row with uploadedById and articleId=null", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const url = await uploadAsCookie(app, cookie);
    const filename = url.split("/").pop()!;
    const row = await prisma.upload.findUnique({ where: { filename } });
    expect(row).not.toBeNull();
    expect(row!.articleId).toBeNull();
    expect(row!.mimeType).toBe("image/png");
    expect(row!.bytes).toBe(PNG_BYTES.length);
    await app.close();
  });

  it("unbound upload: uploader can fetch, other authed user gets 403", async () => {
    const admin = await seedAdmin();
    await seedUser("alice");
    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");
    const url = await uploadAsCookie(app, adminCookie);
    expect(admin.isAdmin).toBe(true); // admin path is exercised separately

    // Uploader (admin here is also uploader+admin): 200
    const ownerRes = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
    expect(ownerRes.statusCode).toBe(200);

    // Non-uploader non-admin: 403
    const otherRes = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
    expect(otherRes.statusCode).toBe(403);
    await app.close();
  });

  it("bound upload: role-member of the article's folder can fetch", async () => {
    await seedAdmin();
    const alice = await seedUser("alice");
    const { role, mod } = await seedRoleAndFolder("public");
    // Alice gets role membership so she can edit articles in this folder
    await prisma.userRole.create({ data: { userId: alice.id, roleId: role.id } });

    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");
    // Admin uploads, then we create an article that embeds the upload as if
    // it were a future Alice publication, then bind it.
    const url = await uploadAsCookie(app, adminCookie);
    const filename = url.split("/").pop()!;
    const article = await prisma.article.create({
      data: {
        title: "with image",
        contentMarkdown: `embed ${url}`,
        folderId: mod.id, roleId: mod.roleId,
        createdById: alice.id,
      },
    });
    // First-bind via the same util the route uses (avoids re-uploading)
    await prisma.upload.update({ where: { filename }, data: { articleId: article.id } });

    // Alice has role on the public folder → canView → 200
    const res = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("bound upload to someone else's doc: 任意登录用户可获取(目录公开可读,去草稿隐私)", async () => {
    const admin = await seedAdmin();
    await seedUser("alice");
    const { mod } = await seedRoleAndFolder("public");
    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");
    const url = await uploadAsCookie(app, adminCookie);
    const filename = url.split("/").pop()!;
    // 去草稿隐私后,目录公开可读 → alice(非作者、非协作者)也能获取文档内嵌的上传。
    const article = await prisma.article.create({
      data: {
        title: "doc",
        contentMarkdown: `embed ${url}`,
        folderId: mod.id, roleId: mod.roleId,
        createdById: admin.id,
      },
    });
    await prisma.upload.update({ where: { filename }, data: { articleId: article.id } });

    const res = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("legacy on-disk file with no Upload row: 404 for non-admin, 200 for admin", async () => {
    await seedAdmin();
    await seedUser("alice");
    // Write a real PNG to disk WITHOUT creating an Upload row.
    await mkdir(UPLOAD_DIR, { recursive: true });
    const legacyFilename = "legacyfilenamewithcuidshape00.png";
    await writeFile(join(UPLOAD_DIR, legacyFilename), PNG_BYTES);

    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");

    const aliceRes = await app.inject({ method: "GET", url: `/uploads/${legacyFilename}`, headers: { cookie: aliceCookie } });
    expect(aliceRes.statusCode).toBe(404);

    const adminRes = await app.inject({ method: "GET", url: `/uploads/${legacyFilename}`, headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(200);
    await app.close();
  });

  it("unbound upload referenced by a viewable LIVE article is served (not 403)", async () => {
    // Data-loss companion: an upload whose articleId is null (e.g. its
    // first-bind article was purged → FK SetNull) but is STILL embedded in
    // a live published article must serve to a viewer who can read that
    // article — the body-permission model treats published content as
    // viewable. Previously this 403'd because the gate only checked the
    // (now-null) articleId.
    await seedAdmin();
    const alice = await seedUser("alice");
    const { role, mod } = await seedRoleAndFolder("public");
    await prisma.userRole.create({ data: { userId: alice.id, roleId: role.id } });

    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");
    const url = await uploadAsCookie(app, adminCookie); // admin uploads, articleId=null
    const filename = url.split("/").pop()!;

    // A live published article (authored by admin) embeds the URL, but the
    // upload row is deliberately left UNBOUND (articleId=null) to simulate
    // the post-SetNull state.
    await prisma.article.create({
      data: {
        title: "still embeds",
        contentMarkdown: `look ${url}`,
        folderId: mod.id, roleId: mod.roleId,
        createdById: (await prisma.user.findFirstOrThrow({ where: { ssoId: "admin" } })).id,
      },
    });
    const row = await prisma.upload.findUnique({ where: { filename } });
    expect(row!.articleId).toBeNull(); // sanity: still unbound

    // Alice (role member, not uploader, not admin) can read the published
    // article → must be served the embedded upload.
    const res = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("upload referenced ONLY inside a code fence is NOT served to an outsider (403)", async () => {
    // The reference-fallback scan must use the SAME extractor semantics as
    // binding/cleanup: a doc that merely QUOTES the upload URL inside a
    // ```code fence``` does not "reference" it. Otherwise a private upload
    // could leak to anyone who can read a published doc that fences its URL.
    const admin = await seedAdmin();
    await seedUser("alice");
    const { role, mod } = await seedRoleAndFolder("public");
    const alice = await prisma.user.findFirstOrThrow({ where: { ssoId: "alice" } });
    await prisma.userRole.create({ data: { userId: alice.id, roleId: role.id } });

    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");
    const url = await uploadAsCookie(app, adminCookie); // admin uploads, articleId=null
    const filename = url.split("/").pop()!;

    // A live published article (admin) mentions the URL ONLY inside a fenced
    // code block — not a genuine embed. The upload stays UNBOUND.
    await prisma.article.create({
      data: {
        title: "only-quotes-in-fence",
        contentMarkdown: "before\n```\nsee ${URL} example\n```\nafter".replace("${URL}", url),
        folderId: mod.id, roleId: mod.roleId,
        createdById: admin.id,
      },
    });
    const row = await prisma.upload.findUnique({ where: { filename } });
    expect(row!.articleId).toBeNull(); // sanity: unbound

    // Alice can read the published doc, but it only fences the URL → 403.
    const res = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("import binds embedded uploads atomically (POST /api/articles/import)", async () => {
    // The import path must bind embedded `/uploads/...` references inside the
    // create transaction so they're anchored against orphan-reaping.
    const admin = await seedAdmin();
    const { role, mod } = await seedRoleAndFolder("public");
    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const url = await uploadAsCookie(app, adminCookie);
    const filename = url.split("/").pop()!;

    const boundary = "----IMP";
    const md = `imported body with ${url}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="roleId"\r\n\r\n${role.id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${mod.id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n导入文档\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.md"\r\nContent-Type: text/markdown\r\n\r\n${md}\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST", url: "/api/articles/import",
      headers: { cookie: adminCookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const articleId = res.json().article.id as string;
    // The embedded upload was bound to the imported article.
    const bound = await prisma.upload.findUnique({ where: { filename } });
    expect(bound!.articleId).toBe(articleId);
    await app.close();
  });

  it("first-bind: re-embedding in a second article does not rebind", async () => {
    await seedAdmin();
    const alice = await seedUser("alice");
    const { role, mod } = await seedRoleAndFolder("public");
    await prisma.userRole.create({ data: { userId: alice.id, roleId: role.id } });

    const app = await buildServer(AUTH);
    const adminCookie = authCookie("admin");
    const aliceCookie = authCookie("alice");
    const url = await uploadAsCookie(app, adminCookie);
    const filename = url.split("/").pop()!;

    // POST first article via the route — triggers bindUploadsToArticle
    const r1 = await app.inject({
      method: "POST", url: "/api/articles",
      headers: { cookie: aliceCookie, "content-type": "application/json" },
      payload: { folderId: mod.id, roleId: mod.roleId, title: "A1", contentMarkdown: `pic ${url}` },
    });
    expect(r1.statusCode).toBe(201);
    const firstArticleId = r1.json().article.id;

    // POST second article that embeds the same /uploads URL
    const r2 = await app.inject({
      method: "POST", url: "/api/articles",
      headers: { cookie: aliceCookie, "content-type": "application/json" },
      payload: { folderId: mod.id, roleId: mod.roleId, title: "A2", contentMarkdown: `pic again ${url}` },
    });
    expect(r2.statusCode).toBe(201);

    const row = await prisma.upload.findUnique({ where: { filename } });
    // First-bind semantics: articleId stays as the first article's id.
    expect(row!.articleId).toBe(firstArticleId);
    await app.close();
  });
});
