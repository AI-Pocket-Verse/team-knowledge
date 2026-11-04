import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { join } from "node:path";
import { stat, unlink } from "node:fs/promises";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { storeImageBuffer, resolveChatImages, loadChatImageDataUris, newEmbedBudget, ImageStoreError, UPLOAD_DIR, MAX_USER_QUOTA_BYTES } from "./image-store.js";

// 1x1 真实 PNG(带合法 magic bytes,file-type 可识别)。
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function createUser(ssoId = "ou_img_tester"): Promise<string> {
  const u = await prisma.user.create({ data: { ssoId, displayName: "图片测试" } });
  return u.id;
}

describe("image-store(聊天图片落盘 + 归属校验)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("storeImageBuffer:合法 PNG 落盘 + Upload 归属记录", async () => {
    const userId = await createUser();
    const stored = await storeImageBuffer(PNG_1PX, userId);
    expect(stored.url).toMatch(/^\/uploads\/[a-z0-9]+\.png$/);
    expect(stored.mimeType).toBe("image/png");
    // 字节真实写盘
    const st = await stat(join(UPLOAD_DIR, stored.filename));
    expect(st.size).toBe(PNG_1PX.length);
    // 归属记录
    const row = await prisma.upload.findFirst({ where: { filename: stored.filename } });
    expect(row?.uploadedById).toBe(userId);
  });

  it("storeImageBuffer:非图片字节 → unsupported_media_type", async () => {
    const userId = await createUser();
    await expect(storeImageBuffer(Buffer.from("not an image at all"), userId)).rejects.toBeInstanceOf(ImageStoreError);
  });

  it("storeImageBuffer:配额满时普通落盘拒绝、但 quotaExempt(AI 生图)放行", async () => {
    const userId = await createUser("ou_quota");
    // 造一条几乎占满 1GB 配额的既有 Upload(只记账,不写盘)。
    await prisma.upload.create({
      data: { filename: "huge.png", mimeType: "image/png", bytes: MAX_USER_QUOTA_BYTES, uploadedById: userId },
    });
    // 用户主动上传 → 仍受配额约束,拒绝。
    await expect(storeImageBuffer(PNG_1PX, userId)).rejects.toMatchObject({ code: "quota_exceeded" });
    // AI 代生成 → quotaExempt 放行,不因用户配额满而失败。
    const stored = await storeImageBuffer(PNG_1PX, userId, undefined, { quotaExempt: true });
    expect(stored.url).toMatch(/^\/uploads\/[a-z0-9]+\.png$/);
  });

  it("resolveChatImages:校验归属并给出绝对路径;他人图片/不存在/非法地址都拒绝", async () => {
    const owner = await createUser("ou_owner");
    const other = await createUser("ou_other");
    const stored = await storeImageBuffer(PNG_1PX, owner);

    const ok = await resolveChatImages(owner, [stored.url]);
    expect(ok.absPaths).toEqual([join(UPLOAD_DIR, stored.filename)]);

    await expect(resolveChatImages(other, [stored.url])).rejects.toThrow(/不属于你|不存在/);
    await expect(resolveChatImages(owner, ["/uploads/nope.png"])).rejects.toThrow(/不存在/);
    await expect(resolveChatImages(owner, ["/etc/passwd"])).rejects.toThrow(/不合法/);
    await expect(resolveChatImages(owner, ["/uploads/../secret"])).rejects.toThrow(/不合法/);
  });

  it("loadChatImageDataUris:把归属本人的图片编码成 base64 data URI", async () => {
    const owner = await createUser("ou_load_owner");
    const stored = await storeImageBuffer(PNG_1PX, owner);
    const out = await loadChatImageDataUris(owner, [stored.url]);
    expect(out.uris).toEqual([`data:image/png;base64,${PNG_1PX.toString("base64")}`]);
  });

  it("loadChatImageDataUris:他人图片 / 不存在 / 非法地址都跳过(不抛错)", async () => {
    const owner = await createUser("ou_load_owner2");
    const other = await createUser("ou_load_other2");
    const foreign = await storeImageBuffer(PNG_1PX, other);
    const out = await loadChatImageDataUris(owner, [
      foreign.url, "/uploads/missing.png", "/etc/passwd", "https://evil.example/x.png",
    ]);
    expect(out).toEqual({ uris: [], skipped: 0 });
  });

  it("loadChatImageDataUris:保序,只丢坏的那条", async () => {
    const owner = await createUser("ou_load_owner3");
    const a = await storeImageBuffer(PNG_1PX, owner);
    const b = await storeImageBuffer(PNG_1PX, owner);
    const out = await loadChatImageDataUris(owner, [a.url, "/uploads/missing.png", b.url]);
    expect(out.uris).toHaveLength(2);
    expect(out.uris.every((u) => u.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("loadChatImageDataUris:像素尺寸过大的图片跳过(文件很小但解码后占用极大内存)", async () => {
    const owner = await createUser("ou_load_bomb");
    // 改写 IHDR 的宽高为 16000×16000:文件仍只有几十字节,解码后约 1GB。
    const bomb = Buffer.from(PNG_1PX);
    bomb.writeUInt32BE(16_000, 16);
    bomb.writeUInt32BE(16_000, 20);
    const big = await storeImageBuffer(bomb, owner);
    const ok = await storeImageBuffer(PNG_1PX, owner);
    const out = await loadChatImageDataUris(owner, [big.url, ok.url]);
    expect(out).toEqual({ uris: [`data:image/png;base64,${PNG_1PX.toString("base64")}`], skipped: 1 });
  });

  it("loadChatImageDataUris:文件本身超过剩余字节预算时不读盘,直接计入未放入", async () => {
    const owner = await createUser("ou_load_noread");
    const a = await storeImageBuffer(PNG_1PX, owner);
    // 删掉磁盘文件:若仍去读盘,会按「文件缺失」静默跳过(skipped=0);预检生效时不读盘,计入 skipped。
    await unlink(join(UPLOAD_DIR, a.url.slice("/uploads/".length)));
    const out = await loadChatImageDataUris(owner, [a.url], { bytes: PNG_1PX.length - 1, pixels: 1_000_000 });
    expect(out).toEqual({ uris: [], skipped: 1 });
  });

  it("loadChatImageDataUris:同一张图里判定过「不放入」的文件,后续消息再引用时不再读盘", async () => {
    const owner = await createUser("ou_load_rejected");
    const bomb = Buffer.from(PNG_1PX);
    bomb.writeUInt32BE(16_000, 16);
    bomb.writeUInt32BE(16_000, 20);
    const big = await storeImageBuffer(bomb, owner);
    const budget = newEmbedBudget();
    expect(await loadChatImageDataUris(owner, [big.url], budget)).toEqual({ uris: [], skipped: 1 });
    // 删掉磁盘文件:若第二次仍读盘,会按「文件缺失」静默跳过(skipped=0)。
    await unlink(join(UPLOAD_DIR, big.url.slice("/uploads/".length)));
    expect(await loadChatImageDataUris(owner, [big.url], budget)).toEqual({ uris: [], skipped: 1 });
  });

  it("loadChatImageDataUris:剩余预算不够而没放入的文件,后续消息再引用时不再读盘", async () => {
    const owner = await createUser("ou_load_budget_rej");
    const img = await storeImageBuffer(PNG_1PX, owner);
    const budget = { bytes: 1024 * 1024, pixels: 0.5, rejected: new Set<string>() }; // 连 1 像素都放不下
    expect(await loadChatImageDataUris(owner, [img.url], budget)).toEqual({ uris: [], skipped: 1 });
    await unlink(join(UPLOAD_DIR, img.url.slice("/uploads/".length)));
    expect(await loadChatImageDataUris(owner, [img.url], budget)).toEqual({ uris: [], skipped: 1 });
  });

  it("loadChatImageDataUris:同一 url 重复只读一次", async () => {
    const owner = await createUser("ou_load_dup");
    const a = await storeImageBuffer(PNG_1PX, owner);
    const out = await loadChatImageDataUris(owner, [a.url, a.url, a.url]);
    expect(out.uris).toHaveLength(1);
  });

  it("loadChatImageDataUris:超出字节预算后停止累加", async () => {
    const owner = await createUser("ou_load_budget");
    const a = await storeImageBuffer(PNG_1PX, owner);
    const b = await storeImageBuffer(PNG_1PX, owner);
    const out = await loadChatImageDataUris(owner, [a.url, b.url], { bytes: PNG_1PX.length, pixels: 1_000_000 });
    expect(out.uris).toHaveLength(1); // first fills the budget; second is dropped
    expect(out.skipped).toBe(1);
  });
});
