// Persist an in-memory image (downloaded from Feishu) into the same uploads
// store that routes/uploads.ts uses, so the imported doc's images live locally
// (the original Feishu media URLs require auth + expire). Ownership is recorded
// on the importing user; bindUploadsToArticle later anchors it to the article.
import { mkdir, writeFile } from "node:fs/promises";
import { BLOCKED_UPLOAD_EXT } from "./uploadPolicy.js";
import { join, resolve } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { fileTypeFromBuffer } from "file-type";
import { prisma } from "../db.js";
import { env } from "../env.js";

const UPLOAD_DIR = resolve(env.DATA_DIR, "uploads");
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Mirror routes/uploads.ts caps so the import path can't bypass the per-user
// quota / size limits those routes enforce.
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_USER_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB

async function exceedsQuota(userId: string, incoming: number): Promise<boolean> {
  const agg = await prisma.upload.aggregate({
    where: { uploadedById: userId },
    _sum: { bytes: true },
  });
  return (agg._sum.bytes ?? 0) + incoming > MAX_USER_QUOTA_BYTES;
}

/**
 * Store image bytes as `uploadedById=userId` and return its `/uploads/<file>`
 * URL. Returns null when the bytes aren't a supported image type (caller emits
 * a placeholder + warning rather than failing the whole import).
 */
export async function storeImageBuffer(userId: string, bytes: Buffer): Promise<string | null> {
  if (bytes.length > MAX_IMG_BYTES || (await exceedsQuota(userId, bytes.length))) return null;
  const detected = await fileTypeFromBuffer(bytes);
  const ext = detected ? EXT_FOR_MIME[detected.mime] : undefined;
  if (!detected || !ext) return null;
  const id = createId();
  const filename = `${id}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, filename), bytes);
  await prisma.upload.create({
    data: { id, filename, mimeType: detected.mime, bytes: bytes.length, uploadedById: userId },
  });
  return `/uploads/${filename}`;
}

// 扩展名黑名单与网页上传共用 utils/uploadPolicy.ts。

function sanitizeExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "bin";
  const raw = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return raw.length === 0 || raw.length > 8 ? "bin" : raw;
}

/**
 * Persist a generic file attachment (downloaded from Feishu) into the uploads
 * store, keeping its original name for the download Content-Disposition. Returns
 * the `/uploads/<file>` URL, or null when the extension is disallowed.
 */
export async function storeFileBuffer(
  userId: string,
  bytes: Buffer,
  originalName: string,
): Promise<string | null> {
  if (bytes.length > MAX_FILE_BYTES || (await exceedsQuota(userId, bytes.length))) return null;
  const ext = sanitizeExt(originalName);
  if (BLOCKED_UPLOAD_EXT.has(ext)) return null;
  const id = createId();
  const filename = `${id}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, filename), bytes);
  const detected = await fileTypeFromBuffer(bytes);
  await prisma.upload.create({
    data: {
      id,
      filename,
      originalName,
      mimeType: detected?.mime ?? "application/octet-stream",
      bytes: bytes.length,
      uploadedById: userId,
    },
  });
  return `/uploads/${filename}`;
}
