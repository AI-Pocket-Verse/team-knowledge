import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// 渲染器换成桩,只观察路由交给它的消息与提示计数;其余(鉴权、读图、预算)走真实链路。
const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../services/chat-share-image/render.js", () => ({ renderChatSharePng: render }));

import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { storeImageBuffer } from "../services/uploads/image-store.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// 文件头声明 4000×4000(1600 万像素,单张不超限),文件本身只有几十字节。
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const bigHeader = () => { const b = Buffer.from(PNG_1PX); b.writeUInt32BE(4000, 16); b.writeUInt32BE(4000, 20); return b; };

describe("POST /api/chat/share-image 嵌图预算", () => {
  beforeEach(async () => {
    await resetDb();
    render.mockReset();
    render.mockImplementation(async (_m: unknown, opts: { onExit?: () => void }) => { opts.onExit?.(); return Buffer.from("png"); });
  });
  afterAll(async () => { await disconnectDb(); });

  it("像素预算由整张图的所有消息共享:同一张大图在多条消息里重复引用,超出部分不放入并计数提示", async () => {
    const admin = await seedAdmin();
    const img = await storeImageBuffer(bigHeader(), admin.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie: authCookie("admin") },
      payload: { messages: [1, 2, 3, 4].map((n) => ({ role: "user", content: `第 ${n} 条`, images: [img.url] })) },
    });
    expect(r.statusCode).toBe(200);
    const [messages, opts] = render.mock.calls[0] as [{ images: string[] }[], { skippedImages: number }];
    // 每张 1600 万像素,整张累计上限 5000 万:前三条放入,第四条不放入。
    expect(messages.map((m) => m.images.length)).toEqual([1, 1, 1, 0]);
    expect(opts.skippedImages).toBe(1);
    expect(await prisma.upload.count()).toBe(1);
    await app.close();
  });
});
