import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("/api/admin/notify-test", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("非管理员 → 403", async () => {
    await seedUser({ ssoId: "u2", isAdmin: false });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/notify-test/scenarios", headers: { cookie: authCookie("u2") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("管理员列出任务:七个场景,默认关闭、(测试环境)无勾选群", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/notify-test/scenarios", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const scenarios = res.json().scenarios as Array<{ key: string; enabled: boolean; selected: string[]; schedule: string }>;
    expect(scenarios.map((s) => s.key).sort()).toEqual(["changelog", "doc_audit", "group_qa", "kb_weekly_report", "meeting_minutes", "skill_updated", "weekly_digest"]);
    const weekly = scenarios.find((s) => s.key === "weekly_digest")!;
    expect(weekly.enabled).toBe(false); // 自动任务默认关闭,须后台显式开启
    expect(weekly.schedule).toContain("每周五 21:00");
    expect(weekly.selected).toEqual([]); // 测试环境 env 默认空 → 未勾选
    await app.close();
  });

  it("PATCH 配置:开启自动任务 → 持久化(存 DB),列表回读一致", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const patch = await app.inject({
      method: "PATCH", url: "/api/admin/notify-test/scenarios/weekly_digest",
      headers: { cookie, "content-type": "application/json" },
      payload: { enabled: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().scenario.enabled).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/admin/notify-test/scenarios", headers: { cookie } });
    const weekly = (list.json().scenarios as Array<{ key: string; enabled: boolean }>).find((s) => s.key === "weekly_digest")!;
    expect(weekly.enabled).toBe(true);
    await app.close();
  });

  it("PATCH:未知任务 key → 404;未知群 id → 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const nf = await app.inject({
      method: "PATCH", url: "/api/admin/notify-test/scenarios/nope",
      headers: { cookie, "content-type": "application/json" },
      payload: { enabled: false },
    });
    expect(nf.statusCode).toBe(404);
    // 测试环境可选群为空,任何 oc_* 都不在可选集合内 → 400。
    const bad = await app.inject({
      method: "PATCH", url: "/api/admin/notify-test/scenarios/weekly_digest",
      headers: { cookie, "content-type": "application/json" },
      payload: { chatIds: ["oc_unknown"] },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("未勾选目标群发送 → 400 no_target", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/admin/notify-test/send",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { key: "skill_updated" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_target");
    expect(res.json().message).toContain("未勾选目标群聊");
    await app.close();
  });

  it("查询不存在的发送任务 → 404", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/notify-test/send/no-such-job", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("未知场景 key → 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/admin/notify-test/send",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { key: "does_not_exist" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("PATCH schedule(触发时刻可配置)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("改星期/时间/单次 → 文案与结构同步;空星期 400;event 类任务 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const ok = await app.inject({
      method: "PATCH", url: "/api/admin/notify-test/scenarios/doc_audit",
      headers: { cookie, "content-type": "application/json" },
      payload: { schedule: { weekdays: [2, 4], hour: 18, minute: 30, repeat: false } },
    });
    expect(ok.statusCode).toBe(200);
    const sc = ok.json().scenario as { cronSchedule: unknown; schedule: string };
    expect(sc.cronSchedule).toEqual({ weekdays: [2, 4], hour: 18, minute: 30, repeat: false });
    expect(sc.schedule).toContain("每周二、四 18:30");
    expect(sc.schedule).toContain("仅执行一次");

    const bad = await app.inject({
      method: "PATCH", url: "/api/admin/notify-test/scenarios/doc_audit",
      headers: { cookie, "content-type": "application/json" },
      payload: { schedule: { weekdays: [], hour: 9, minute: 0, repeat: true } },
    });
    expect(bad.statusCode).toBe(400);

    const evt = await app.inject({
      method: "PATCH", url: "/api/admin/notify-test/scenarios/skill_updated",
      headers: { cookie, "content-type": "application/json" },
      payload: { schedule: { weekdays: [1], hour: 9, minute: 0, repeat: true } },
    });
    expect(evt.statusCode).toBe(400);
    await app.close();
  });
});
