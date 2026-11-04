import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { invalidateProviderCache } from "../services/llm/registry.js";
import { createConversation } from "../services/chat/conversations.js";
import { storeImageBuffer } from "../services/uploads/image-store.js";

// 1x1 真实 PNG(合法 magic bytes,file-type 可识别)——供「只发图片」用例落一张真图。
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-claude.sh");
const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("POST /api/agents/chat conversationId", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "拆成三步";
    invalidateProviderCache();
  });
  afterEach(() => { delete process.env.CLAUDE_BIN; delete process.env.FAKE_CLAUDE_REPLY; invalidateProviderCache(); });
  afterAll(async () => { await disconnectDb(); });

  it("带 conversationId → 落到该会话;缺省 → 新建", async () => {
    const admin = await seedAdmin();
    const prod = await prisma.role.create({ data: { name: "产品" } });
    // 建会话时 lastMessageAt 已初始化为创建时刻(新会话据此排到列表最前)。
    const conv = await createConversation(admin.id);
    expect(conv.lastMessageAt).not.toBeNull();
    // 人为把它回拨到很早,便于断言「跑完一轮后被 touch 推到更晚」。
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(1000) } });
    const app = await buildServer(AUTH);

    await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "需求怎么拆", targetRoleIds: [prod.id], conversationId: conv.id },
    });
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id } })).toBeGreaterThan(0);
    // M1 回归:编排路径每轮 assistant 落库后要触达 lastMessageAt(推到更晚),否则会话列表新消息不置顶
    //(只有 runChatTurn 路径触达是不够的——首页助手走的是这条)。
    const after = (await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).lastMessageAt;
    expect(after!.getTime()).toBeGreaterThan(1000);

    const before = await prisma.conversation.count({ where: { userId: admin.id } });
    await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "再拆一次", targetRoleIds: [prod.id] },
    });
    expect(await prisma.conversation.count({ where: { userId: admin.id } })).toBe(before + 1);
    await app.close();
  });

  it("只发图片(message 为空)→ 接受并落库(用户图 + 助手回复),不再 400", async () => {
    const admin = await seedAdmin();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "这是一张 1x1 的测试图片。";
    invalidateProviderCache();
    const stored = await storeImageBuffer(PNG_1PX, admin.id); // 该用户名下一张真图
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "", images: [stored.url] },
    });
    expect(res.statusCode).toBe(200); // 不再被「消息不能为空」拦下
    // 用户消息:content 仍为空(气泡只显示图),images 含该图 url
    const userMsg = await prisma.chatMessage.findFirst({ where: { conversationId: { not: undefined }, role: "user" }, orderBy: { createdAt: "desc" } });
    expect(userMsg?.content).toBe("");
    expect(userMsg?.images).toContain(stored.url);
    // 助手回复已落库(模型看图作答)
    expect(await prisma.chatMessage.count({ where: { role: "assistant" } })).toBeGreaterThan(0);
    await app.close();
  });

  it("空文字且无图 → 400 消息不能为空", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
