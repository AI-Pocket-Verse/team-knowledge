import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { extractUploadFilenames } from "./uploadBinding.js";

export interface CleanupOptions {
  /** Minimum age before an orphan is eligible for deletion. Defaults to 7 days. */
  olderThanMs?: number;
  /** Don't actually delete — just report what would be deleted. */
  dryRun?: boolean;
}

export interface CleanupResult {
  deletedRows: number;
  deletedFiles: number;
  scannedFiles: number;
}

/**
 * Removes orphan uploads in two passes:
 *
 *  1. Upload rows whose `articleId` is null AND were uploaded more than
 *     `olderThanMs` ago (default 7 days) — these are abandoned uploads
 *     the user never embedded in a saved article. The corresponding disk
 *     file is removed first, then the row.
 *
 *  2. Files in `${DATA_DIR}/uploads/` that have no matching Upload row —
 *     legacy data from before the Upload table existed, or remnants of
 *     a crashed write. Files newer than `olderThanMs` are skipped to
 *     avoid racing with an in-flight upload.
 *
 * Returns counts so callers can log or alert. Never throws on a single
 * file error; one bad inode shouldn't fail the whole sweep.
 */
export async function cleanupOrphanUploads(opts: CleanupOptions = {}): Promise<CleanupResult> {
  const olderThanMs = opts.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  const dryRun = !!opts.dryRun;
  const uploadDir = resolve(env.DATA_DIR, "uploads");
  const cutoff = new Date(Date.now() - olderThanMs);

  let deletedRows = 0;
  let deletedFiles = 0;
  let scannedFiles = 0;

  // Pass 1: abandoned Upload rows (articleId null, older than cutoff).
  const orphanRows = await prisma.upload.findMany({
    where: { articleId: null, createdAt: { lt: cutoff } },
    select: { id: true, filename: true },
  });

  // Reference-aware guard. An upload can be articleId=null yet STILL be
  // embedded in a LIVE article's body — e.g. it was first-bound to an
  // article that was later permanently purged (the FK SetNull cleared
  // articleId) while a *different* live article B kept referencing the
  // image. Deleting such a row here would physically remove a file B
  // still serves → permanent data loss. So before reaping any orphan
  // candidate, build a map of every `/uploads/<filename>` reference that
  // appears in a live (deletedAt:null) article, using the SAME extractor
  // the binding path uses (code fences stripped) so "referenced" means
  // exactly what binding would claim. A referenced orphan is NOT deleted;
  // we re-bind it to one referencing article so serving + future cleanup
  // are correct again. Only scan bodies when there's something to reap.
  const referencedBy = new Map<string, string>(); // filename → live articleId
  if (orphanRows.length > 0) {
    const liveArticles = await prisma.article.findMany({
      where: { deletedAt: null },
      select: { id: true, contentMarkdown: true },
    });
    const orphanNames = new Set(orphanRows.map((r) => r.filename));
    for (const art of liveArticles) {
      for (const fn of extractUploadFilenames(art.contentMarkdown)) {
        // First live article wins as the re-bind anchor; only record
        // names that are actually orphan candidates so the map stays small.
        if (orphanNames.has(fn) && !referencedBy.has(fn)) {
          referencedBy.set(fn, art.id);
        }
      }
    }
  }

  // 聊天图片引用保护:聊天/飞书入站图片不绑文章(articleId 恒为 null),
  // 但被 ChatMessage.images(JSON 的 /uploads/* 数组)长期引用 —— 没这层
  // 保护,定时清理会在 7 天后把聊天历史里的图全删掉。被聊天引用的一律
  // 保留(不重绑,聊天图本就无文章可绑)。
  const chatReferenced = new Set<string>();
  if (orphanRows.length > 0) {
    // 分批游标扫描:放开聊天保留上限后,带图消息可能很多,避免一次性把全部行
    // 读进内存。每批 2000 条,按 id 游标推进直到取尽。
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.chatMessage.findMany({
        where: { images: { not: null } },
        select: { id: true, images: true },
        orderBy: { id: "asc" },
        take: 2000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      for (const m of batch) {
        try {
          for (const u of JSON.parse(m.images ?? "[]") as unknown[]) {
            if (typeof u === "string" && u.startsWith("/uploads/")) {
              chatReferenced.add(u.slice("/uploads/".length));
            }
          }
        } catch { /* 损坏的 JSON → 该行不提供保护 */ }
      }
      cursor = batch[batch.length - 1]!.id;
    }
  }

  // 专家头像:上传时不绑文章,但被 RoleExpert.avatarUrl 长期引用,同样不能清掉。
  const avatarReferenced = new Set<string>();
  if (orphanRows.length > 0) {
    const experts = await prisma.roleExpert.findMany({
      where: { avatarUrl: { not: null } },
      select: { avatarUrl: true },
    });
    for (const e of experts) {
      if (e.avatarUrl?.startsWith("/uploads/")) avatarReferenced.add(e.avatarUrl.slice("/uploads/".length));
    }
  }

  for (const row of orphanRows) {
    if (chatReferenced.has(row.filename)) continue; // 聊天还在用,保留
    if (avatarReferenced.has(row.filename)) continue; // 专家头像还在用,保留
    const liveArticleId = referencedBy.get(row.filename);
    if (liveArticleId) {
      // Still referenced by a live article — never delete. Re-bind so the
      // serving permission gate resolves and a future purge of THIS
      // article re-triggers the same protection rather than leaving the
      // row dangling. Dry-run reports nothing for a preserved row.
      if (!dryRun) {
        await prisma.upload.update({
          where: { id: row.id },
          data: { articleId: liveArticleId },
        });
      }
      continue;
    }
    if (!dryRun) {
      try { await unlink(join(uploadDir, row.filename)); } catch { /* file may already be gone */ }
      await prisma.upload.delete({ where: { id: row.id } });
    }
    deletedRows += 1;
    deletedFiles += 1;
  }

  // Pass 2: files on disk with no Upload row.
  let dirEntries: string[];
  try {
    dirEntries = await readdir(uploadDir);
  } catch {
    return { deletedRows, deletedFiles, scannedFiles };
  }
  // Skip protected marker files (e.g. .migrated from the legacy move).
  const candidates = dirEntries.filter((n) => n !== ".migrated" && !n.startsWith("."));
  scannedFiles = candidates.length;
  if (candidates.length === 0) return { deletedRows, deletedFiles, scannedFiles };

  const known = await prisma.upload.findMany({
    where: { filename: { in: candidates } },
    select: { filename: true },
  });
  const knownSet = new Set(known.map((u) => u.filename));

  for (const name of candidates) {
    if (knownSet.has(name)) continue;
    let st;
    try { st = await stat(join(uploadDir, name)); } catch { continue; }
    if (st.mtime > cutoff) continue; // too new — could be racing with upload
    if (!dryRun) {
      try { await unlink(join(uploadDir, name)); } catch { continue; }
    }
    deletedFiles += 1;
  }

  return { deletedRows, deletedFiles, scannedFiles };
}
