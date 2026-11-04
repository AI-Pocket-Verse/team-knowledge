// 图片落盘的共享内核:web 上传路由(/api/uploads/image)与飞书入站图片
// (/api/internal/feishu/image)共用同一套校验(白名单 MIME + magic-byte +
// 5MB + 每用户配额)与存储(DATA_DIR/uploads + Upload 表记录归属)。
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { fileTypeFromBuffer } from "file-type";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { imagePixelSize } from "../../utils/imageSize.js";
import { L, appLang, type Lang } from "../../utils/lang.js";

export const UPLOAD_DIR = resolve(env.DATA_DIR, "uploads");
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_USER_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB,与文件上传共享
// 嵌入分享图的像素上限。解码峰值按渐进式 JPEG 约每像素 17 字节估算(无损等更耗内存的 JPEG
// 在 imagePixelSize 里就被拒绝):整张分享图累计 5000 万像素约 0.85～1.3GB 峰值,单张也以此为限(一张手机全尺寸照片或四张普通照片);
// 全局同一时间只渲染一张(见 shareImageSemaphore),部署模板 MemoryMax=2G 留有余量。
const MAX_EMBED_IMAGE_PIXELS = 50_000_000;
const MAX_EMBED_TOTAL_PIXELS = 50_000_000;
// 分享图的渲染器(resvg-js)解码不了 WebP,嵌进去只是空白框,不占预算、按「未放入」提示。
const EMBEDDABLE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif"]);

/** 一张分享图里所有消息共享的嵌图预算(字节数与解码像素数)。`rejected` 记下已判定不放入的
 *  文件,后续消息再引用时不再读盘解析。 */
export interface EmbedBudget { bytes: number; pixels: number; rejected?: Set<string> }
export function newEmbedBudget(): EmbedBudget {
  return { bytes: 12 * 1024 * 1024, pixels: MAX_EMBED_TOTAL_PIXELS, rejected: new Set() };
}
export const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 校验失败时抛出,带 HTTP 语义(路由映射状态码用)。 */
export class ImageStoreError extends Error {
  constructor(
    public code: "payload_too_large" | "unsupported_media_type" | "quota_exceeded",
    message: string,
  ) {
    super(message);
  }
}

async function exceedsQuota(userId: string, incoming: number): Promise<boolean> {
  const agg = await prisma.upload.aggregate({ where: { uploadedById: userId }, _sum: { bytes: true } });
  return (agg._sum.bytes ?? 0) + incoming > MAX_USER_QUOTA_BYTES;
}

export interface StoredImage {
  url: string; // /uploads/<filename>
  filename: string;
  mimeType: string;
  bytes: number;
}

/** 校验并落盘一张图片(claimedMime 仅作快速白名单预检,可不传;真实类型以
 *  magic-byte 为准)。成功返回 /uploads/<file> 视图;失败抛 ImageStoreError。 */
export async function storeImageBuffer(
  buffer: Buffer,
  userId: string,
  claimedMime?: string,
  // quotaExempt:AI 文生图等【系统代生成】的图,用户并未主动上传,故不计入其 1GB 配额
  // (否则系统生的图会悄悄占满用户配额,把他自己的上传也一并卡死)。仍受 MAX_IMAGE_BYTES
  // 单张上限约束,且生图侧另有每用户限流 + 并发闸兜底,不会无界膨胀。
  opts?: { quotaExempt?: boolean; lang?: Lang },
): Promise<StoredImage> {
  const lang = opts?.lang ?? appLang();
  if (buffer.length === 0) throw new ImageStoreError("unsupported_media_type", L(lang, "空文件", "Empty file"));
  if (buffer.length > MAX_IMAGE_BYTES) throw new ImageStoreError("payload_too_large", L(lang, "文件超过 20MB 上限", "File exceeds the 20 MB limit"));
  if (claimedMime && !ALLOWED_IMAGE_MIME.has(claimedMime)) {
    throw new ImageStoreError("unsupported_media_type", L(lang, "仅支持 PNG/JPEG/GIF/WebP", "Only PNG / JPEG / GIF / WebP are supported"));
  }
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_IMAGE_MIME.has(detected.mime)) {
    throw new ImageStoreError("unsupported_media_type", L(lang, "文件类型与扩展名不匹配", "File type does not match its extension"));
  }
  if (!opts?.quotaExempt && await exceedsQuota(userId, buffer.length)) {
    throw new ImageStoreError("quota_exceeded", L(lang, "存储配额已用尽", "Storage quota used up"));
  }

  const ext = EXT_FOR_MIME[detected.mime] ?? "bin";
  const id = createId();
  const filename = `${id}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, filename), buffer);
  await prisma.upload.create({
    data: { id, filename, mimeType: detected.mime, bytes: buffer.length, uploadedById: userId },
  });
  return { url: `/uploads/${filename}`, filename, mimeType: detected.mime, bytes: buffer.length };
}

/** 校验聊天消息携带的图片 URL 列表(均须形如 /uploads/<file>、归属于该用户、
 *  且确为图片),返回 LLM 可读的绝对路径。任何一张不合法即抛错(防把别人的
 *  上传或非图片文件喂给模型)。 */
export async function resolveChatImages(
  userId: string,
  urls: string[],
  lang: Lang = appLang(),
): Promise<{ urls: string[]; absPaths: string[] }> {
  if (urls.length === 0) return { urls: [], absPaths: [] };
  const filenames = urls.map((u) => {
    const m = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(u);
    if (!m) throw new Error(L(lang, "图片地址不合法", "Invalid image URL"));
    return m[1]!;
  });
  const rows = await prisma.upload.findMany({
    where: { filename: { in: filenames }, uploadedById: userId },
    select: { filename: true, mimeType: true },
  });
  const byName = new Map(rows.map((r) => [r.filename, r]));
  for (const f of filenames) {
    const row = byName.get(f);
    if (!row) throw new Error(L(lang, "图片不存在或不属于你", "Image not found or not yours"));
    if (!ALLOWED_IMAGE_MIME.has(row.mimeType)) throw new Error(L(lang, "仅支持图片附件", "Only image attachments are supported"));
  }
  return { urls, absPaths: filenames.map((f) => join(UPLOAD_DIR, f)) };
}

/** 读取聊天消息携带的图片(须归属该用户、确为图片),编码成 base64 data URI,
 *  供「生成图片」把原图嵌进 SVG。与 resolveChatImages 不同,本函数**容错**:任何
 *  一张地址不合法 / 不归属 / 缺文件,只跳过它而不抛错(分享出图不应因一张坏图整体 500)。
 *  保持入参顺序。`budget` 由整张分享图的所有消息共享并就地扣减;本人的图因过大、
 *  超出预算或格式不支持而没放入的,计入 `skipped`,由调用方在图里提示。 */
export async function loadChatImageDataUris(
  userId: string,
  urls: string[],
  budget: EmbedBudget = newEmbedBudget(),
): Promise<{ uris: string[]; skipped: number }> {
  if (!urls?.length) return { uris: [], skipped: 0 };
  // De-dup so a url repeated N times isn't read + embedded N times (Set keeps
  // first-seen order).
  const names = [...new Set(
    urls
      .map((u) => /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(u)?.[1])
      .filter((x): x is string => Boolean(x)),
  )];
  if (names.length === 0) return { uris: [], skipped: 0 };
  const rows = await prisma.upload.findMany({
    where: { filename: { in: names }, uploadedById: userId },
    select: { filename: true, mimeType: true, bytes: true },
  });
  const rowByName = new Map(rows.map((r) => [r.filename, r]));
  const uris: string[] = [];
  let skipped = 0;
  for (const f of names) {
    const row = rowByName.get(f);
    const mime = row?.mimeType;
    if (!row || !mime || !ALLOWED_IMAGE_MIME.has(mime)) continue; // unknown / not owned / not an image → skip
    if (!EMBEDDABLE_IMAGE_MIME.has(mime) || budget.rejected?.has(f)) { skipped++; continue; }
    // 预算已用完或文件本身就超预算:不必读盘(多条消息重复引用大图时,逐张读 20MB 会拖慢整个请求)。
    if (row.bytes > budget.bytes || budget.pixels <= 0) { budget.rejected?.add(f); skipped++; continue; }
    let buf: Buffer;
    try {
      buf = await readFile(join(UPLOAD_DIR, f));
    } catch { continue; /* file missing on disk → skip */ }
    // 嵌进图片后要解码栅格化,内存按像素数算:单张或累计过大(含读不出尺寸)的不放入。
    const size = imagePixelSize(buf);
    const pixels = size ? size.width * size.height : Infinity;
    if (buf.length > budget.bytes || pixels > MAX_EMBED_IMAGE_PIXELS || pixels > budget.pixels) {
      // 同一张分享图里预算只减不增:这次放不下,后续消息再引用也放不下,记下来不再读盘。
      budget.rejected?.add(f);
      skipped++;
      continue;
    }
    budget.bytes -= buf.length;
    budget.pixels -= pixels;
    uris.push(`data:${mime};base64,${buf.toString("base64")}`);
  }
  return { uris, skipped };
}
