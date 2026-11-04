import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, seedAdmin, mockAuth } from "../../test-helpers/db.js";
import { invalidateProviderCache } from "../services/llm/registry.js";
import { createEscalation } from "../services/experts/escalation.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
// In tests INTERNAL_API_TOKEN is left at the env default (setup-env doesn't override it).
const TOKEN = "dev-internal-token-change-in-prod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../../scripts/fake-claude.sh");

describe("/api/internal/feishu/chat", () => {
  beforeEach(async () => {
    await resetDb();
    invalidateProviderCache();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "你好呀";
  });
  afterAll(async () => { await disconnectDb(); });

  it("401 without the internal token", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/chat",
      payload: { openId: "ou_a", text: "hi" },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("unknown open_id → SSE need_login (no LLM call)", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/chat",
      headers: { "x-internal-token": TOKEN },
      payload: { openId: "ou_missing", text: "hi" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/event: need_login/);
    await app.close();
  });

  it("known member → streams token + done", async () => {
    await seedUser({ ssoId: "ou_member", displayName: "M" });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/chat",
      headers: { "x-internal-token": TOKEN },
      payload: { openId: "ou_member", text: "在吗" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(r.body).toMatch(/event: token/);
    expect(r.body).toMatch(/event: done/);
    // 落点 = 该用户飞书专用会话(singletonKey="feishu"),保活双向。
    const convs = await prisma.conversation.findMany();
    expect(convs).toHaveLength(1);
    expect(convs[0]!.singletonKey).toBe("feishu");
    expect(await prisma.chatMessage.count({ where: { conversationId: convs[0]!.id } })).toBe(2); // user + assistant
    await app.close();
  });

  it("scope=group → streams but creates no conversation (stateless)", async () => {
    await seedUser({ ssoId: "ou_member", displayName: "M" });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/chat",
      headers: { "x-internal-token": TOKEN },
      payload: { openId: "ou_member", text: "产品怎么用", scope: "group" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/event: token/);
    expect(r.body).toMatch(/event: done/);
    // 群聊无状态:不建会话、不写消息。
    expect(await prisma.conversation.count()).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
    await app.close();
  });
});

describe("/api/internal/feishu/image(飞书入站图片落盘)", () => {
  const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  beforeEach(async () => { await resetDb(); });

  it("401 without the internal token", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/image",
      headers: { "content-type": "application/octet-stream", "x-open-id": "ou_a" },
      payload: PNG_1PX,
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("非成员 open_id → 404", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/image",
      headers: { "content-type": "application/octet-stream", "x-internal-token": TOKEN, "x-open-id": "ou_nobody" },
      payload: PNG_1PX,
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("成员图片 → 201 落盘并归属该用户;随后 /chat 可引用(归属校验通过)", async () => {
    await seedUser({ ssoId: "ou_img", isAdmin: false });
    const app = await buildServer(AUTH);
    const up = await app.inject({
      method: "POST", url: "/api/internal/feishu/image",
      headers: { "content-type": "application/octet-stream", "x-internal-token": TOKEN, "x-open-id": "ou_img" },
      payload: PNG_1PX,
    });
    expect(up.statusCode).toBe(201);
    const { url, mimeType } = up.json() as { url: string; mimeType: string };
    expect(url).toMatch(/^\/uploads\/[a-z0-9]+\.png$/);
    expect(mimeType).toBe("image/png");
    const row = await prisma.upload.findFirst({ where: { filename: url.replace("/uploads/", "") } });
    const user = await prisma.user.findUnique({ where: { ssoId: "ou_img" } });
    expect(row?.uploadedById).toBe(user?.id);
    await app.close();
  });

  it("非图片字节 → 415", async () => {
    await seedUser({ ssoId: "ou_img2", isAdmin: false });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/feishu/image",
      headers: { "content-type": "application/octet-stream", "x-internal-token": TOKEN, "x-open-id": "ou_img2" },
      payload: Buffer.from("plain text bytes"),
    });
    expect(r.statusCode).toBe(415);
    await app.close();
  });
});

describe("/api/internal/expert-escalation/resolve(飞书升级卡片回流)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function makeEsc(assigneeId: string) {
    const role = await prisma.role.create({ data: { name: "技术" } });
    return createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: ["甲", "乙"], assigneeUserId: assigneeId });
  }

  it("401 缺 token", async () => {
    const app = await buildServer(AUTH);
    const r = await app.inject({ method: "POST", url: "/api/internal/expert-escalation/resolve", payload: { escalationId: "x", resolution: "甲", operatorOpenId: "ou_a" } });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("负责人点按钮 → resolved + 记 resolvedById;幂等重复点不覆盖", async () => {
    const owner = await seedUser({ ssoId: "ou_owner" });
    const esc = await makeEsc(owner.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/expert-escalation/resolve",
      headers: { "x-internal-token": TOKEN },
      payload: { escalationId: esc.id, resolution: "甲", operatorOpenId: "ou_owner" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("resolved");
    const row = await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } });
    expect(row.resolution).toBe("甲");
    expect(row.resolvedById).toBe(owner.id);
    // 幂等:再点(选乙)不覆盖已终态。
    await app.inject({ method: "POST", url: "/api/internal/expert-escalation/resolve", headers: { "x-internal-token": TOKEN }, payload: { escalationId: esc.id, resolution: "乙", operatorOpenId: "ou_owner" } });
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).resolution).toBe("甲");
    await app.close();
  });

  it("非负责人(非管理员)点按钮 → 403,不改单", async () => {
    const owner = await seedUser({ ssoId: "ou_owner" });
    await seedUser({ ssoId: "ou_intruder" });
    const esc = await makeEsc(owner.id);
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST", url: "/api/internal/expert-escalation/resolve",
      headers: { "x-internal-token": TOKEN },
      payload: { escalationId: esc.id, resolution: "乱拍", operatorOpenId: "ou_intruder" },
    });
    expect(r.statusCode).toBe(403);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).status).toBe("pending");
    await app.close();
  });

  it("管理员可代拍;升级单不存在 → 404", async () => {
    await seedAdmin({ ssoId: "ou_admin" });
    const other = await seedUser({ ssoId: "ou_other" });
    const esc = await makeEsc(other.id);
    const app = await buildServer(AUTH);
    const ok = await app.inject({ method: "POST", url: "/api/internal/expert-escalation/resolve", headers: { "x-internal-token": TOKEN }, payload: { escalationId: esc.id, resolution: "甲", operatorOpenId: "ou_admin" } });
    expect(ok.statusCode).toBe(200);
    const miss = await app.inject({ method: "POST", url: "/api/internal/expert-escalation/resolve", headers: { "x-internal-token": TOKEN }, payload: { escalationId: "nope", resolution: "甲", operatorOpenId: "ou_admin" } });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });
});
