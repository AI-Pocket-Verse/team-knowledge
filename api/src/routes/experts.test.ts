import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { setExpert } from "../services/experts/config.js";
import { createEscalation } from "../services/experts/escalation.js";
import { invalidateProviderCache } from "../services/llm/registry.js";

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-claude.sh");

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("routes/agents", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { delete process.env.CLAUDE_BIN; delete process.env.FAKE_CLAUDE_REPLY; invalidateProviderCache(); });
  afterAll(async () => { await disconnectDb(); });

  it("GET /api/agents 只列出 enabled 的专家", async () => {
    await seedAdmin();
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "技术" } });
    await setExpert(r2.id, { enabled: false }, "admin"); // 停用技术专家
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const names = res.json().experts.map((e: { name: string }) => e.name);
    expect(names).toContain("产品");
    expect(names).not.toContain("技术");
    await app.close();
  });

  it("POST /api/agents/chat 空消息 → 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "  " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/agents/chat 走 SSE:流式 token + step + done(权威 answer)", async () => {
    const admin = await seedAdmin();
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "拆成三个验收点";
    invalidateProviderCache();
    const app = await buildServer(AUTH);
    // 不选专家 → 走总台助手自答(此路径才逐 token 流式;选了专家会先进「门控」整段缓冲,
    // 见 orchestrator runGeneralAnswer:门控不流式以防 [[EXPERT]] 前夹带正文串字)。SSE 帧框架两路一致。
    const res = await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "需求怎么拆" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const body = res.payload;
    expect(body).toContain("event: token");
    expect(body).toContain("event: step");
    expect(body).toContain("event: done");
    // done 帧里带权威 answer
    const doneLine = body.split("\n").find((l) => l.startsWith("data: {") && l.includes("\"answer\""));
    expect(doneLine).toBeTruthy();
    expect(JSON.parse(doneLine!.slice("data: ".length)).answer).toBe("拆成三个验收点");
    // 落库:user + assistant 各一条,落在统一的总台会话(roleId="",与首页助手共享)。
    const msgs = await prisma.chatMessage.findMany({ orderBy: { createdAt: "asc" }, include: { conversation: true } });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(new Set(msgs.map((m) => m.conversation.roleId))).toEqual(new Set([""]));
    await app.close();
  });

  it("无专家时 KB 命中 → done 带 doc 出处;落总台会话", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id, createdById: admin.id } });
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
    process.env.FAKE_CLAUDE_REPLY = "建议免密 30 天";
    invalidateProviderCache();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/agents/chat",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { message: "登录改造" }, // 不指定专家 + 分诊(fake)返回非 JSON → 无专家 → 走 general
    });
    expect(res.statusCode).toBe(200);
    const doneLine = res.payload.split("\n").find((l) => l.startsWith("data: {") && l.includes("\"citations\""));
    expect(doneLine).toBeTruthy();
    const done = JSON.parse(doneLine!.slice("data: ".length));
    expect(done.citations.some((c: { source: string; title: string }) => c.source === "doc" && c.title === "登录改造方案")).toBe(true);
    // 无 conversationId → 惰性新建一条普通会话(singletonKey=null)。
    const conv = await prisma.conversation.findFirst({ where: { userId: admin.id, singletonKey: null } });
    expect(conv).not.toBeNull();
    await app.close();
  });

  it("POST escalations/:id/resolve 由负责人拍板 → resolved;缺结论 → 400", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: ["甲", "乙"], assigneeUserId: admin.id });
    const app = await buildServer(AUTH);

    const bad = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/resolve`, headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: {} });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/resolve`, headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { resolution: "选甲" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("resolved");
    const after = await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } });
    expect(after.resolution).toBe("选甲");
    expect(after.resolvedById).toBe(admin.id); // 审计:记下谁拍的板
    await app.close();
  });

  it("非负责人(且非管理员)resolve → 403,不改动升级单", async () => {
    await seedAdmin();
    const owner = await seedUser({ ssoId: "owner" });
    const intruder = await seedUser({ ssoId: "intruder" });
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: ["甲"], assigneeUserId: owner.id });
    const app = await buildServer(AUTH);

    const res = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/resolve`, headers: { cookie: authCookie(intruder.ssoId), "content-type": "application/json" }, payload: { resolution: "我乱拍" } });
    expect(res.statusCode).toBe(403);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).status).toBe("pending");
    await app.close();
  });

  it("resolve 不存在的升级单 → 404", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: `/api/agents/escalations/nope/resolve`, headers: { cookie: authCookie(owner.ssoId), "content-type": "application/json" }, payload: { resolution: "x" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /api/agents 带 canEdit(管理员 → true)", async () => {
    await seedAdmin();
    await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().experts[0].canEdit).toBe(true);
    await app.close();
  });

  it("forward:当前 assignee 可转交 → 改 assignee;非 assignee → 403;非负责人转交不成", async () => {
    const asker = await seedUser({ ssoId: "ou_asker" });
    const target = await seedUser({ ssoId: "ou_target", displayName: "T" });
    await seedUser({ ssoId: "ou_other" });
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: ["甲"], assigneeUserId: asker.id });
    const app = await buildServer(AUTH);

    const bad = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/forward`, headers: { cookie: authCookie("ou_other"), "content-type": "application/json" }, payload: { toUserId: target.id } });
    expect(bad.statusCode).toBe(403);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).assigneeUserId).toBe(asker.id);

    const ok = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/forward`, headers: { cookie: authCookie("ou_asker"), "content-type": "application/json" }, payload: { toUserId: target.id } });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).assigneeUserId).toBe(target.id);
    await app.close();
  });

  it("forward 链式:转交后新 assignee 可再转交,原提问者失权", async () => {
    const asker = await seedUser({ ssoId: "ou_asker" });
    const b = await seedUser({ ssoId: "ou_b", displayName: "B" });
    const c = await seedUser({ ssoId: "ou_c", displayName: "C" });
    const role = await prisma.role.create({ data: { name: "技术" } });
    const esc = await createEscalation({ conversationId: "c1", roleId: role.id, background: "b", question: "q", options: [], assigneeUserId: asker.id });
    const app = await buildServer(AUTH);
    await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/forward`, headers: { cookie: authCookie("ou_asker"), "content-type": "application/json" }, payload: { toUserId: b.id } });
    // 原提问者已失权
    const stale = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/forward`, headers: { cookie: authCookie("ou_asker"), "content-type": "application/json" }, payload: { toUserId: c.id } });
    expect(stale.statusCode).toBe(403);
    // 新 assignee(B)可再转交给 C
    const chain = await app.inject({ method: "POST", url: `/api/agents/escalations/${esc.id}/forward`, headers: { cookie: authCookie("ou_b"), "content-type": "application/json" }, payload: { toUserId: c.id } });
    expect(chain.statusCode).toBe(200);
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: esc.id } })).assigneeUserId).toBe(c.id);
    await app.close();
  });

  it("GET /api/me/escalations 列出我作为负责人的待办", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "技术" } });
    await createEscalation({ conversationId: "c1", roleId: role.id, background: "卡住了", question: "选哪个", options: ["甲"], assigneeUserId: admin.id });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/me/escalations", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].question).toBe("选哪个");
    expect(res.json().items[0].options).toEqual(["甲"]);
    await app.close();
  });
});
