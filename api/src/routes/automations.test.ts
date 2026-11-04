import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedUser(ssoId: string) {
  return prisma.user.create({ data: { ssoId, displayName: ssoId.toUpperCase() } });
}
const CRON = { scheduleKind: "cron" as const, scheduleConfig: { weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 0 } };
const json = { "content-type": "application/json" };

describe("/api/automations 自动化 CRUD", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("创建 → 列表含该任务 + 计算 nextRunAt/标签 + 内置模板", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const create = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "每日 AI 新闻", prompt: "整理今日 AI 新闻", ...CRON } });
    expect(create.statusCode).toBe(200);
    const a = create.json();
    expect(a.scheduleLabel).toBe("每天 07:00");
    expect(a.nextRunAt).toBeTruthy();     // 已算出下一次
    expect(a.enabled).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/automations", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.automations).toHaveLength(1);
    expect(body.templates.length).toBeGreaterThan(0); // 内置模板
    await app.close();
  });

  it("非法 webhook → 400;非法调度(cron 空 weekdays)→ 400", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const badHook = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "x", prompt: "y", webhookUrl: "https://evil.com/hook", ...CRON } });
    expect(badHook.statusCode).toBe(400);
    const badSched = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "x", prompt: "y", scheduleKind: "cron", scheduleConfig: { weekdays: [], hour: 7, minute: 0 } } });
    expect(badSched.statusCode).toBe(400);
    // 合法飞书 webhook 可以过
    const ok = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "x", prompt: "y", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc-123", ...CRON } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("每人任务数有上限；超过返回 400 并说明原因", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const { MAX_AUTOMATIONS_PER_USER } = await import("../services/automation/service.js");
    for (let i = 0; i < MAX_AUTOMATIONS_PER_USER; i++) {
      const r = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: `t${i}`, prompt: "p", ...CRON } });
      expect(r.statusCode).toBe(200);
    }
    const over = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "over", prompt: "p", ...CRON } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe("invalid_input");
    expect(over.json().message).toContain("最多");
    // 别的用户不受影响
    await seedUser("u2");
    const other = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie: authCookie("u2"), ...json }, payload: { name: "x", prompt: "p", ...CRON } });
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it("按间隔的任务最短 10 分钟", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const bad = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "x", prompt: "y", scheduleKind: "interval", scheduleConfig: { everyMs: 60_000 } } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "x", prompt: "y", scheduleKind: "interval", scheduleConfig: { everyMs: 600_000 } } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("暂停 → enabled=false & nextRunAt=null;恢复 → 重新算出 nextRunAt", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    const paused = await app.inject({ method: "POST", url: `/api/automations/${a.id}/pause`, headers: { cookie } });
    expect(paused.json().enabled).toBe(false);
    expect(paused.json().nextRunAt).toBeNull();
    const resumed = await app.inject({ method: "POST", url: `/api/automations/${a.id}/resume`, headers: { cookie } });
    expect(resumed.json().enabled).toBe(true);
    expect(resumed.json().nextRunAt).toBeTruthy();
    await app.close();
  });

  it("过去时刻的单次任务 → 400(按当前设置不会有下一次运行)", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const res = await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "x", prompt: "y", scheduleKind: "once", scheduleConfig: { atMs: 1000 } } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("运行详情:归属校验(他人 404)+ 卡片摊平为 markdown", async () => {
    await seedUser("u1"); await seedUser("u2");
    const app = await buildServer(AUTH);
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie: authCookie("u1"), ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    const run = await prisma.automationRun.create({ data: {
      automationId: a.id, status: "success",
      output: JSON.stringify({ msg_type: "interactive", card: { header: { title: { content: "标题X" } }, elements: [{ tag: "markdown", content: "正文Y" }] } }),
    } });
    // 他人 → 404
    expect((await app.inject({ method: "GET", url: `/api/automations/runs/${run.id}`, headers: { cookie: authCookie("u2") } })).statusCode).toBe(404);
    // owner → 200 + displayText 已摊平
    const detail = (await app.inject({ method: "GET", url: `/api/automations/runs/${run.id}`, headers: { cookie: authCookie("u1") } })).json();
    expect(detail.displayText).toContain("# 标题X");
    expect(detail.displayText).toContain("正文Y");
    await app.close();
  });

  it("超时的 running 记录在读取列表时自愈为失败", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    const run = await prisma.automationRun.create({ data: { automationId: a.id, status: "running", startedAt: new Date(Date.now() - 20 * 60_000) } });
    expect((await app.inject({ method: "GET", url: "/api/automations", headers: { cookie } })).statusCode).toBe(200);
    expect((await prisma.automationRun.findUnique({ where: { id: run.id } }))?.status).toBe("failed");
    await app.close();
  });

  it("坏的 scheduleConfig 不让列表 500(降级为『调度配置异常』)", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    await prisma.automation.update({ where: { id: a.id }, data: { scheduleConfig: "{坏 json" } });
    const list = await app.inject({ method: "GET", url: "/api/automations", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().automations[0].scheduleLabel).toBe("调度配置异常");
    await app.close();
  });

  it("运行记录分页:首页 10 条 + hasMore;游标翻页取更早且无重叠", async () => {
    await seedUser("u1");
    const app = await buildServer(AUTH);
    const cookie = authCookie("u1");
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie, ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    const base = Date.now() - 12 * 60_000;
    for (let i = 0; i < 12; i++) {
      await prisma.automationRun.create({ data: { automationId: a.id, status: "success", startedAt: new Date(base + i * 60_000) } });
    }
    const list = (await app.inject({ method: "GET", url: "/api/automations", headers: { cookie } })).json();
    expect(list.recentRuns).toHaveLength(10);
    expect(list.runsHasMore).toBe(true);
    const lastId = list.recentRuns[list.recentRuns.length - 1].id;
    const page2 = (await app.inject({ method: "GET", url: `/api/automations/runs?cursor=${lastId}&limit=10`, headers: { cookie } })).json();
    expect(page2.runs).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    const seen = new Set(list.recentRuns.map((r: { id: string }) => r.id));
    expect(page2.runs.every((r: { id: string }) => !seen.has(r.id))).toBe(true);
    await app.close();
  });

  it("单任务运行分页 /:id/runs:每页 5 条 + hasMore;不含 running;他人 404", async () => {
    await seedUser("u1"); await seedUser("u2");
    const app = await buildServer(AUTH);
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie: authCookie("u1"), ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    const base = Date.now() - 10 * 60_000;
    for (let i = 0; i < 7; i++) await prisma.automationRun.create({ data: { automationId: a.id, status: "success", startedAt: new Date(base + i * 60_000) } });
    await prisma.automationRun.create({ data: { automationId: a.id, status: "running", startedAt: new Date(base + 8 * 60_000) } }); // running 不计
    const p1 = (await app.inject({ method: "GET", url: `/api/automations/${a.id}/runs?limit=5`, headers: { cookie: authCookie("u1") } })).json();
    expect(p1.runs).toHaveLength(5);
    expect(p1.hasMore).toBe(true);
    expect(p1.runs.every((r: { status: string }) => r.status !== "running")).toBe(true);
    const p2 = (await app.inject({ method: "GET", url: `/api/automations/${a.id}/runs?cursor=${p1.runs[4].id}&limit=5`, headers: { cookie: authCookie("u1") } })).json();
    expect(p2.runs).toHaveLength(2);
    expect(p2.hasMore).toBe(false);
    expect((await app.inject({ method: "GET", url: `/api/automations/${a.id}/runs`, headers: { cookie: authCookie("u2") } })).statusCode).toBe(404);
    await app.close();
  });

  it("置顶 / 取消置顶:pinnedAt 置位/清空;他人 404", async () => {
    await seedUser("u1"); await seedUser("u2");
    const app = await buildServer(AUTH);
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie: authCookie("u1"), ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    const pinned = await app.inject({ method: "POST", url: `/api/automations/${a.id}/pin`, headers: { cookie: authCookie("u1"), ...json }, payload: { pinned: true } });
    expect(pinned.json().pinnedAt).toBeTruthy();
    const unpinned = await app.inject({ method: "POST", url: `/api/automations/${a.id}/pin`, headers: { cookie: authCookie("u1"), ...json }, payload: { pinned: false } });
    expect(unpinned.json().pinnedAt).toBeNull();
    expect((await app.inject({ method: "POST", url: `/api/automations/${a.id}/pin`, headers: { cookie: authCookie("u2"), ...json }, payload: { pinned: true } })).statusCode).toBe(404);
    await app.close();
  });

  it("更新 / 删除 带归属校验:他人操作 404", async () => {
    await seedUser("u1"); await seedUser("u2");
    const app = await buildServer(AUTH);
    const a = (await app.inject({ method: "POST", url: "/api/automations", headers: { cookie: authCookie("u1"), ...json }, payload: { name: "t", prompt: "p", ...CRON } })).json();
    // u2 改/删/取 → 404
    expect((await app.inject({ method: "PATCH", url: `/api/automations/${a.id}`, headers: { cookie: authCookie("u2"), ...json }, payload: { name: "n", prompt: "p", ...CRON } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/automations/${a.id}`, headers: { cookie: authCookie("u2") } })).statusCode).toBe(404);
    // u1 改成功、删成功
    expect((await app.inject({ method: "PATCH", url: `/api/automations/${a.id}`, headers: { cookie: authCookie("u1"), ...json }, payload: { name: "改了", prompt: "p2", ...CRON } })).json().name).toBe("改了");
    expect((await app.inject({ method: "DELETE", url: `/api/automations/${a.id}`, headers: { cookie: authCookie("u1") } })).statusCode).toBe(200);
    expect(await prisma.automation.count()).toBe(0);
    await app.close();
  });
});
