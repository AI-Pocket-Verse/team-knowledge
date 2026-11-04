import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prisma, disconnectDb } from "../db.js";
import { env } from "../env.js";
import { resetDb, seedAdmin } from "../../test-helpers/db.js";
import { cleanupOrphanUploads } from "./uploadCleanup.js";

const UPLOAD_DIR = resolve(env.DATA_DIR, "uploads");
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

async function writeFileWithMtime(name: string, mtime: Date): Promise<void> {
  const path = join(UPLOAD_DIR, name);
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path, TINY_PNG);
  // utimes accepts seconds-since-epoch
  const { utimes } = await import("node:fs/promises");
  await utimes(path, mtime, mtime);
}

describe("cleanupOrphanUploads", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("deletes Upload rows older than the cutoff with articleId=null + removes their files", async () => {
    const admin = await seedAdmin();
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    // Two old orphan rows + matching files
    for (const name of ["old1a8b9c0d1e2f3g4h5i6j7k.png", "old2a8b9c0d1e2f3g4h5i6j7k.png"]) {
      await prisma.upload.create({
        data: { id: name.split(".")[0]!, filename: name, mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, createdAt: oldDate },
      });
      await writeFileWithMtime(name, oldDate);
    }

    const result = await cleanupOrphanUploads({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.deletedRows).toBe(2);
    expect(result.deletedFiles).toBeGreaterThanOrEqual(2);

    const remaining = await prisma.upload.count();
    expect(remaining).toBe(0);
  });

  it("preserves Upload rows newer than cutoff and rows bound to an article", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "r" } });
    const fold = await prisma.folder.create({ data: { name: "m", roleId: role.id, visibility: "public", templateType: "article-list" } });
    const article = await prisma.article.create({ data: { title: "a", contentMarkdown: "x", folderId: fold.id, roleId: fold.roleId, createdById: admin.id } });

    // Bound upload, even if old — must NOT be deleted
    await prisma.upload.create({
      data: { id: "bound1a8b9c0d1e2f3g4h5i6j", filename: "bound1a8b9c0d1e2f3g4h5i6j.png", mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, articleId: article.id, createdAt: new Date(Date.now() - 30 * 86400_000) },
    });
    // Recent orphan — must NOT be deleted yet
    await prisma.upload.create({
      data: { id: "new1aa8b9c0d1e2f3g4h5i6j", filename: "new1aa8b9c0d1e2f3g4h5i6j.png", mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, createdAt: new Date() },
    });

    const result = await cleanupOrphanUploads({ olderThanMs: 7 * 86400_000 });
    expect(result.deletedRows).toBe(0);
    expect(await prisma.upload.count()).toBe(2);
  });

  it("removes disk files with no Upload row when older than cutoff (legacy junk)", async () => {
    await seedAdmin();
    const oldDate = new Date(Date.now() - 10 * 86400_000);
    const legacyName = "legacyaa8b9c0d1e2f3g4h5i6j.png";
    await writeFileWithMtime(legacyName, oldDate);

    // Sanity: no Upload row exists for it
    expect(await prisma.upload.findUnique({ where: { filename: legacyName } })).toBeNull();

    const result = await cleanupOrphanUploads({ olderThanMs: 7 * 86400_000 });
    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);

    // File is gone now
    let exists = true;
    try { await stat(join(UPLOAD_DIR, legacyName)); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("does NOT reap an unbound upload still referenced by a live article — re-binds it instead", async () => {
    // Data-loss guard: an old upload with articleId=null whose
    // `/uploads/<name>` URL is still embedded in a LIVE article must be
    // preserved (and re-bound to that article), not physically deleted.
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "r" } });
    const fold = await prisma.folder.create({ data: { name: "m", roleId: role.id, visibility: "public", templateType: "article-list" } });
    const name = "refdaa8b9c0d1e2f3g4h5i6j.png";
    const liveArticle = await prisma.article.create({
      data: { title: "B", contentMarkdown: `still embeds ![pic](/uploads/${name})`, folderId: fold.id, roleId: fold.roleId, createdById: admin.id },
    });
    // Old, UNBOUND upload (e.g. its first-bind article was purged → FK SetNull).
    const oldDate = new Date(Date.now() - 30 * 86400_000);
    await prisma.upload.create({
      data: { id: name.split(".")[0]!, filename: name, mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, createdAt: oldDate },
    });
    await writeFileWithMtime(name, oldDate);

    const result = await cleanupOrphanUploads({ olderThanMs: 7 * 86400_000 });
    expect(result.deletedRows).toBe(0);
    expect(result.deletedFiles).toBe(0);

    // Row survives AND is re-bound to the referencing live article.
    const row = await prisma.upload.findUnique({ where: { filename: name } });
    expect(row).not.toBeNull();
    expect(row!.articleId).toBe(liveArticle.id);
    // File still on disk.
    let exists = true;
    try { await stat(join(UPLOAD_DIR, name)); } catch { exists = false; }
    expect(exists).toBe(true);
  });

  it("reaps a truly-orphaned upload referenced only by a SOFT-DELETED article", async () => {
    // A reference inside a binned (deletedAt != null) article does NOT
    // protect the upload — only LIVE articles count. So the orphan is reaped.
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "r" } });
    const fold = await prisma.folder.create({ data: { name: "m", roleId: role.id, visibility: "public", templateType: "article-list" } });
    const name = "deadaa8b9c0d1e2f3g4h5i6j.png";
    await prisma.article.create({
      data: { title: "binned", contentMarkdown: `embeds /uploads/${name}`, folderId: fold.id, roleId: fold.roleId, createdById: admin.id, deletedAt: new Date(), deletedById: admin.id },
    });
    const oldDate = new Date(Date.now() - 30 * 86400_000);
    await prisma.upload.create({
      data: { id: name.split(".")[0]!, filename: name, mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, createdAt: oldDate },
    });
    await writeFileWithMtime(name, oldDate);

    const result = await cleanupOrphanUploads({ olderThanMs: 7 * 86400_000 });
    expect(result.deletedRows).toBe(1);
    expect(await prisma.upload.findUnique({ where: { filename: name } })).toBeNull();
    let exists = true;
    try { await stat(join(UPLOAD_DIR, name)); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("dryRun: counts but does not delete", async () => {
    const admin = await seedAdmin();
    const oldDate = new Date(Date.now() - 10 * 86400_000);
    await prisma.upload.create({
      data: { id: "dryaa8b9c0d1e2f3g4h5i6jk", filename: "dryaa8b9c0d1e2f3g4h5i6jk.png", mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, createdAt: oldDate },
    });
    await writeFileWithMtime("dryaa8b9c0d1e2f3g4h5i6jk.png", oldDate);

    const result = await cleanupOrphanUploads({ olderThanMs: 7 * 86400_000, dryRun: true });
    expect(result.deletedRows).toBe(1);
    expect(await prisma.upload.count()).toBe(1);
  });
});

describe("cleanupOrphanUploads — 聊天图片引用保护", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("被 ChatMessage.images 引用的超期未绑定上传:保留;无引用的照常回收", async () => {
    const admin = await seedAdmin();
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const kept = "chatkeep0d1e2f3g4h5i6j7k.png";
    const reaped = "chatgone0d1e2f3g4h5i6j7k.png";
    for (const name of [kept, reaped]) {
      await prisma.upload.create({
        data: { id: name.split(".")[0]!, filename: name, mimeType: "image/png", bytes: TINY_PNG.length, uploadedById: admin.id, createdAt: oldDate },
      });
      await writeFileWithMtime(name, oldDate);
    }
    // 聊天消息引用 kept(聊天图 articleId 恒为 null,只有这条引用保它)。
    const conv = await prisma.conversation.create({ data: { userId: admin.id } });
    await prisma.chatMessage.create({
      data: { conversationId: conv.id, role: "user", content: "看图", images: JSON.stringify([`/uploads/${kept}`]) },
    });

    await cleanupOrphanUploads({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });

    expect(await prisma.upload.findFirst({ where: { filename: kept } })).not.toBeNull();
    await expect(stat(join(UPLOAD_DIR, kept))).resolves.toBeTruthy();
    expect(await prisma.upload.findFirst({ where: { filename: reaped } })).toBeNull();
  });
});
