import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb } from "../db.js";
import { buildServer } from "../server.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { prisma } from "../db.js";
import { createConversation, getOwnedConversation } from "../services/chat/conversations.js";

// 列表只显示「有过对话」的会话,故测试里的普通会话需补一条消息才会出现。
async function seedMsg(conversationId: string) {
  await prisma.chatMessage.create({ data: { conversationId, role: "user", content: "hi" } });
}

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("/api/chat/conversations 列表/改名/删", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("列表/改名/删 端点", async () => {
    const user = await seedUser({ ssoId: "u" });
    const a = await createConversation(user.id, "甲");
    const b = await createConversation(user.id, "乙");
    await seedMsg(a.id); await seedMsg(b.id); // 有消息才进列表
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    const list = await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    // 空的飞书会话现在不进列表(有消息才显示;避免点开是 Hi助手空态),故仅 a、b 两条。
    const items = list.json().items as Array<{ isFeishu: boolean }>;
    expect(items.length).toBe(2);
    expect(items.every((c) => !c.isFeishu)).toBe(true);

    const rn = await app.inject({ method: "PATCH", url: `/api/chat/conversations/${a.id}`, headers: { cookie, "content-type": "application/json" }, payload: { title: "改名了" } });
    expect(rn.statusCode).toBe(200);
    expect((await getOwnedConversation(user.id, a.id))!.title).toBe("改名了");

    const del = await app.inject({ method: "DELETE", url: `/api/chat/conversations/${b.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    expect(await getOwnedConversation(user.id, b.id)).toBeNull();
    await app.close();
  });

  it("越权改名/删 → 404", async () => {
    const user = await seedUser({ ssoId: "u" });
    const other = await seedUser({ ssoId: "o" });
    const foreign = await createConversation(other.id, "别人的");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u");

    const rn = await app.inject({ method: "PATCH", url: `/api/chat/conversations/${foreign.id}`, headers: { cookie, "content-type": "application/json" }, payload: { title: "x" } });
    expect(rn.statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: `/api/chat/conversations/${foreign.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(404);
    await app.close();
  });
});
