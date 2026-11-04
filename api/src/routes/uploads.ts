import type { FastifyInstance } from "fastify";
import { BLOCKED_UPLOAD_EXT } from "../utils/uploadPolicy.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { fileTypeFromBuffer } from "file-type";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { requireUser } from "../utils/guards.js";
import { storeImageBuffer, ImageStoreError } from "../services/uploads/image-store.js";

const UPLOAD_DIR = resolve(env.DATA_DIR, "uploads");
const MAX_BYTES = 20 * 1024 * 1024; // 20MB — chat / article images
const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30MB — generic attachments (pdf/docx/zip)
// Per-user disk quota across all upload kinds. Stops a
// user from filling the disk with upload-then-delete loops faster than
// the 7-day orphan cleanup can reclaim. Counts every Upload row owned
// by the user — bound, orphan, or admin's own — uniformly.
const MAX_USER_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB

// 扩展名黑名单见 utils/uploadPolicy.ts(与飞书附件导入共用)。

// Sums every byte this user has on disk and returns true if adding
// `incoming` bytes would push them past MAX_USER_QUOTA_BYTES. Admins
// share the same quota — we deliberately don't exempt them so the cap
// can't be bypassed by switching accounts.
async function exceedsQuota(userId: string, incoming: number): Promise<boolean> {
  const agg = await prisma.upload.aggregate({
    where: { uploadedById: userId },
    _sum: { bytes: true },
  });
  const used = agg._sum.bytes ?? 0;
  return used + incoming > MAX_USER_QUOTA_BYTES;
}

function sanitizeExt(name: string): string {
  // Take the last dot-segment, lowercase, strip anything non-alphanumeric.
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "bin";
  const raw = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (raw.length === 0 || raw.length > 8) return "bin";
  return raw;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/uploads/image", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    let file: Awaited<ReturnType<typeof req.file>> | null = null;
    try {
      file = await req.file({ limits: { fileSize: MAX_BYTES } });
    } catch {
      return reply.code(400).send({ error: "invalid_input", message: "请上传一个文件" });
    }
    if (!file) {
      return reply.code(400).send({ error: "invalid_input", message: "请上传一个文件" });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: "payload_too_large", message: "文件超过 20MB 上限" });
    }

    // 校验(尺寸/MIME 白名单/magic-byte/配额)+ 落盘 + Upload 归属记录,与
    // 飞书入站图片共用同一内核(services/uploads/image-store.ts)。articleId
    // 起始为 null;嵌入文章保存时由 bindUploadsToArticle 绑定。
    try {
      const stored = await storeImageBuffer(buffer, user.id, file.mimetype);
      reply.code(201);
      return { url: stored.url, bytes: stored.bytes };
    } catch (e) {
      if (e instanceof ImageStoreError) {
        const status = e.code === "unsupported_media_type" ? 415 : 413;
        return reply.code(status).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });

  // Generic file attachment endpoint (Plan A). Unlike /image it accepts
  // any MIME, up to MAX_FILE_BYTES, and skips magic-byte validation
  // (text formats like .md/.csv have none). Security is layered:
  //   - blocked extensions list rejects executables / scripts
  //   - filename comes from a server-side cuid; the user's original
  //     name is stored separately for the download Content-Disposition
  //   - GET /uploads/:filename still enforces article-permission gate
  app.post("/api/uploads/file", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    let file: Awaited<ReturnType<typeof req.file>> | null = null;
    try {
      file = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
    } catch {
      return reply.code(400).send({ error: "invalid_input", message: "请上传一个文件" });
    }
    if (!file) {
      return reply.code(400).send({ error: "invalid_input", message: "请上传一个文件" });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: "payload_too_large", message: "文件超过 30MB 上限" });
    }
    if (buffer.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: "payload_too_large", message: "文件超过 30MB 上限" });
    }

    const originalName = file.filename || "untitled";
    const ext = sanitizeExt(originalName);
    if (BLOCKED_UPLOAD_EXT.has(ext)) {
      return reply.code(415).send({ error: "unsupported_media_type", message: `不允许上传 .${ext} 文件` });
    }

    if (await exceedsQuota(user.id, buffer.length)) {
      return reply.code(413).send({ error: "quota_exceeded", message: "存储配额已用尽" });
    }

    // Resolve the stored MIME from the actual bytes when possible. The
    // client-supplied file.mimetype is untrustworthy (a user can claim
    // any Content-Type in the multipart header). If file-type can't
    // detect (truly text payloads like .md, .csv have no magic), fall
    // through to application/octet-stream so we never store a lie like
    // "text/html" on a .txt blob.
    const detected = await fileTypeFromBuffer(buffer);
    const storedMime = detected?.mime ?? "application/octet-stream";

    const id = createId();
    const filename = `${id}.${ext}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(join(UPLOAD_DIR, filename), buffer);

    await prisma.upload.create({
      data: {
        id,
        filename,
        originalName,
        mimeType: storedMime,
        bytes: buffer.length,
        uploadedById: user.id,
      },
    });

    reply.code(201);
    return {
      url: `/uploads/${filename}`,
      filename,
      originalName,
      bytes: buffer.length,
      mimeType: storedMime,
    };
  });
}
