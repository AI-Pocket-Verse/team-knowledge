import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { storeImageBuffer } from "../services/uploads/image-store.js";
import { createConversation } from "../services/chat/conversations.js";

// 1x1 真实 PNG(合法 magic bytes,storeImageBuffer 的 file-type 校验可过)。
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
import { invalidateProviderCache } from "../services/llm/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../scripts/fake-claude.sh");

async function setupArticle() {
  const role = await prisma.role.create({ data: { name: "产品" } });
  const mod = await prisma.folder.create({ data: { name: "PRD", roleId: role.id, visibility: "public" } });
  return prisma.article.create({ data: { title: "V2.3 接入方案", contentMarkdown: "接入签名校验", folderId: mod.id, roleId: mod.roleId } });
}

describe("/api/chat", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "hello [#1]";
  });
  afterAll(async () => { await disconnectDb(); });

  it("GET /api/chat/conversation requires auth", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "GET", url: "/api/chat/conversation" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("GET /api/chat/conversation 返回指定空会话", async () => {
    const admin = await seedAdmin();
    const conv = await createConversation(admin.id);
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.id).toBe(conv.id);
    expect(body.messages).toEqual([]);
    expect(body.hasMoreOlder).toBe(false);
    await app.close();
  });

  it("分页:默认取最近 100 条 + hasMoreOlder;before 取更早一页", async () => {
    const admin = await seedAdmin();
    const conv = await createConversation(admin.id);
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const convId = conv.id;
    const BASE = 1700000000000;
    for (let i = 0; i < 130; i++) {
      await prisma.chatMessage.create({ data: { conversationId: convId, role: i % 2 ? "assistant" : "user", content: `m${i}`, source: "web", createdAt: new Date(BASE + i * 1000) } });
    }
    // 默认:最近 100 条(升序),hasMoreOlder=true
    const b1 = (await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${convId}`, headers: { cookie } })).json();
    expect(b1.messages).toHaveLength(100);
    expect(b1.messages[0].content).toBe("m30");   // 130-100
    expect(b1.messages[99].content).toBe("m129");
    expect(b1.hasMoreOlder).toBe(true);
    // before=最老一条 → 更早 20 条(升序),hasMoreOlder=true
    const before = b1.messages[0].id;
    const b2 = (await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${convId}&before=${before}&limit=20`, headers: { cookie } })).json();
    expect(b2.messages).toHaveLength(20);
    expect(b2.messages[19].content).toBe("m29");
    expect(b2.messages[0].content).toBe("m10");
    expect(b2.hasMoreOlder).toBe(true);
    await app.close();
  });

  it("POST /api/chat/message rejects empty body", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "" } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/chat/share-image requires auth", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/chat/share-image",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("POST /api/chat/share-image returns a PNG for selected messages", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie },
      payload: {
        title: "对话摘录",
        messages: [
          { role: "user", content: "这个项目怎么部署？" },
          { role: "assistant", content: "用 `deploy.sh update` 一键部署。\n\n- 拉取代码\n- 构建迁移" },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    const png = r.rawPayload;
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    expect(png.length).toBeGreaterThan(2000);
    await app.close();
  });

  it("POST /api/chat/share-image 行数极多时在画布上限内截断，超过总行数上限则 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const ok = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie },
      payload: { messages: [{ role: "user", content: "a\n".repeat(4000) }] },
    });
    expect(ok.statusCode).toBe(200);
    // 修复前单条消息不受画布上限约束：4000 行 → 约 11.6 万 px 高、20 秒以上。
    // 断言高度而非耗时（耗时受机器负载影响）：逻辑高度上限 12000，高图 1.5x 栅格化。
    expect(ok.rawPayload.readUInt32BE(20)).toBeLessThanOrEqual((12_000 + 200) * 1.5);
    const tooMany = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie },
      payload: { messages: [{ role: "user", content: "a\n".repeat(6000) }] },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toBe("too_large");
    await app.close();
  });

  it("POST /api/chat/share-image 同一成员同时只生成一张:并发第二张 429,第一张结束后可再生成", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const send = (content: string) => app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie },
      payload: { messages: [{ role: "user", content }] },
    });
    const first = send("啊".repeat(1500)); // 渲染要数秒
    await new Promise((r) => setTimeout(r, 300));
    const second = await send("短");
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("share_image_in_progress");
    expect((await first).statusCode).toBe(200);
    // 第一张的线程退出后占位与全局名额都已释放
    expect((await send("短")).statusCode).toBe(200);
    await app.close();
  }, 60_000);

  it("POST /api/chat/share-image rejects an empty selection", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie }, payload: { messages: [] },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/chat/share-image embeds an owned image and still returns a PNG", async () => {
    const admin = await seedAdmin();
    const stored = await storeImageBuffer(PNG_1PX, admin.id); // owned /uploads/<file>
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie },
      payload: { messages: [{ role: "user", content: "看这张图", images: [stored.url] }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.rawPayload.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    await app.close();
  });

  it("POST /api/chat/share-image silently skips a foreign image url (no 500)", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST", url: "/api/chat/share-image", headers: { cookie },
      payload: { messages: [{ role: "user", content: "图没了", images: ["/uploads/not-mine.png"] }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    await app.close();
  });

  it("POST /api/chat/message streams tokens and persists assistant message", async () => {
    await seedAdmin();
    await setupArticle();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r = await app.inject({
      method: "POST", url: "/api/chat/message", headers: { cookie },
      payload: { content: "接入怎么做" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = r.body;
    expect(body).toMatch(/event: token/);
    expect(body).toMatch(/event: done/);
    const convs = await prisma.conversation.findMany();
    expect(convs).toHaveLength(1);
    const msgs = await prisma.chatMessage.findMany({ orderBy: { createdAt: "asc" } });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe("hello [#1]");
    await app.close();
  });

  it("GET /api/chat/conversation hydrates citedRefs for assistant messages", async () => {
    const admin = await seedAdmin();
    const article = await setupArticle();
    const conv = await createConversation(admin.id);
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // Use a query that will match the FTS5 index so retrieval populates
    // citedArticleIds on the assistant turn.
    await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "接入方案", conversationId: conv.id } });
    const r = await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie } });
    const body = r.json();
    const assistant = body.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.citedArticleIds).toEqual([article.id]);
    expect(assistant.citedRefs).toEqual([
      { n: 1, articleId: article.id, title: article.title, folderId: article.folderId, roleId: expect.any(String) },
    ]);
    await app.close();
  });

  it("subsequent GET returns persisted history", async () => {
    const admin = await seedAdmin();
    await setupArticle();
    const conv = await createConversation(admin.id);
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "hi", conversationId: conv.id } });
    const r = await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie } });
    expect(r.json().messages).toHaveLength(2);
    await app.close();
  });

  it("history includes prior identical user messages (regression: NOT-by-id, not NOT-by-content)", async () => {
    const admin = await seedAdmin();
    await setupArticle();
    const conv = await createConversation(admin.id);
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // Send the same content twice INTO THE SAME conversation; the second turn's
    // history should include the first turn's user message + first assistant reply.
    await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "再来一次", conversationId: conv.id } });
    await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "再来一次", conversationId: conv.id } });
    // Four rows total in this one conversation: 2x user + 2x assistant. Nothing dropped.
    const msgs = await prisma.chatMessage.findMany({ where: { conversationId: conv.id } });
    expect(msgs).toHaveLength(4);
    await app.close();
  });

  it("persists partial assistant text when the CLI errors mid-stream", async () => {
    await seedAdmin();
    await setupArticle();
    // Fake claude emits 2 token chunks, then exits with auth error.
    process.env.FAKE_CLAUDE_REPLY = "已经看到一段输出";
    process.env.FAKE_CLAUDE_ERROR = "auth";
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "接入方案" } });
    const msgs = await prisma.chatMessage.findMany({ orderBy: { createdAt: "asc" } });
    // FAKE_CLAUDE_ERROR=auth exits 1 before emitting tokens, so there's
    // no partial text to keep — assistant row should be absent.
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
    delete process.env.FAKE_CLAUDE_ERROR;
    await app.close();
  });

  it("two concurrent first-sends 各自惰性新建会话,都不 500", async () => {
    await seedAdmin();
    await setupArticle();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    // 多会话模型:不带 conversationId 的发送各自惰性新建一条会话。两条并发首发
    // → 两条独立会话,都返回 200(不再共享单例,也不会 P2002 500)。
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "接入方案" } }),
      app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "再问一次" } }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const convs = await prisma.conversation.findMany();
    expect(convs).toHaveLength(2);
    await app.close();
  });

  it("DELETE /api/chat/conversation wipes messages", async () => {
    const admin = await seedAdmin();
    await setupArticle();
    const conv = await createConversation(admin.id);
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    await app.inject({ method: "POST", url: "/api/chat/message", headers: { cookie }, payload: { content: "hi", conversationId: conv.id } });
    const del = await app.inject({ method: "DELETE", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: `/api/chat/conversation?conversationId=${conv.id}`, headers: { cookie } });
    expect(after.json().messages).toEqual([]);
    await app.close();
  });
});
