import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { callGeneralLlm, deliverToFeishu } = vi.hoisted(() => ({
  callGeneralLlm: vi.fn(),
  deliverToFeishu: vi.fn(),
}));
vi.mock("../experts/orchestrator.js", () => ({ callGeneralLlm: (...a: unknown[]) => callGeneralLlm(...a) }));
vi.mock("./webhook.js", async (orig) => ({
  ...(await orig<typeof import("./webhook.js")>()),
  deliverToFeishu: (...a: unknown[]) => deliverToFeishu(...a),
}));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { runAutomation } from "./run.js";
import { tick } from "./scheduler.js";

const HOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";

async function seedAutomation(userId: string, over: Record<string, unknown> = {}) {
  return prisma.automation.create({
    data: {
      userId, name: "A", prompt: "p", webhookUrl: HOOK,
      scheduleKind: "interval", scheduleConfig: JSON.stringify({ everyMs: 3_600_000 }),
      nextRunAt: new Date(Date.now() - 1000),
      ...over,
    },
  });
}

describe("automation 运行", () => {
  beforeEach(async () => { await resetDb(); callGeneralLlm.mockReset(); deliverToFeishu.mockReset(); });
  afterAll(async () => { await disconnectDb(); });

  it("所有者已停用:runAutomation 不运行(不调 LLM、不记运行)", async () => {
    const u = await seedUser({ ssoId: "ou_off", isActive: false });
    const a = await seedAutomation(u.id);
    const r = await runAutomation(a.id);
    expect(r).toBe("skipped");
    expect(callGeneralLlm).not.toHaveBeenCalled();
    expect(await prisma.automationRun.count({ where: { automationId: a.id } })).toBe(0);
  });

  it("所有者已停用:tick 不会选中其任务", async () => {
    const u = await seedUser({ ssoId: "ou_off2", isActive: false });
    const a = await seedAutomation(u.id);
    await tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(callGeneralLlm).not.toHaveBeenCalled();
    expect(await prisma.automationRun.count({ where: { automationId: a.id } })).toBe(0);
  });

  it("webhook 投递是确定性失败(4xx):不排退避重试,按正常节拍推进", async () => {
    const u = await seedUser({ ssoId: "ou_on" });
    const a = await seedAutomation(u.id);
    callGeneralLlm.mockResolvedValue("hello");
    deliverToFeishu.mockResolvedValue({ ok: false, httpStatus: 400, error: "bad", retryable: false });
    await tick();
    await vi.waitFor(async () => {
      const row = await prisma.automation.findUnique({ where: { id: a.id } });
      expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000); // 下个整点节拍,不是退避
    });
    const row = await prisma.automation.findUnique({ where: { id: a.id } });
    expect(row!.retryCount).toBe(0);
    expect(callGeneralLlm).toHaveBeenCalledTimes(1);
  });

  it("LLM 无产出:仍走退避重试", async () => {
    const u = await seedUser({ ssoId: "ou_on2" });
    const a = await seedAutomation(u.id);
    callGeneralLlm.mockResolvedValue(null);
    await tick();
    await vi.waitFor(async () => {
      const row = await prisma.automation.findUnique({ where: { id: a.id } });
      expect(row!.retryCount).toBe(1);
    });
  });
});
