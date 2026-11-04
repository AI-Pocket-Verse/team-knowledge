import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { prisma } from "../../db.js";
import { listScenarios, sendScenario, startSendJob, getSendJob, NoTargetError, AlreadyRunningError } from "./index.js";
import { clearAllRunning } from "./running.js";

describe("notify-test scenarios(飞书群通知控制台)", () => {
  // listScenarios 读 DB 里的场景配置(含可改的触发时刻)—— 清掉前面测试文件
  // 残留的 Setting 行,否则时刻文案断言会被别的用例写入的配置污染。
  // running 计数也清掉:startSendJob 的并发防抖按它判定。
  beforeEach(async () => { await resetDb(); clearAllRunning(); });

  it("listScenarios 含五个任务,带触发方式/时机 + 配置(默认关闭)", async () => {
    const scenarios = await listScenarios();
    const keys = scenarios.map((s) => s.key);
    expect(keys).toContain("skill_updated");
    expect(keys).toContain("weekly_digest");
    expect(keys).toContain("meeting_minutes");
    expect(keys).toContain("doc_audit");
    expect(keys).toContain("changelog");

    const weekly = scenarios.find((s) => s.key === "weekly_digest")!;
    expect(weekly.triggerType).toBe("cron");
    expect(weekly.schedule).toContain("每周五 21:00");
    expect(weekly.enabled).toBe(false); // 未配置过 → 默认关闭(须后台显式开启)

    const audit = scenarios.find((s) => s.key === "doc_audit")!;
    expect(audit.schedule).toContain("09:00");

    const skill = scenarios.find((s) => s.key === "skill_updated")!;
    expect(skill.triggerType).toBe("event");
    // 测试环境 env 默认均为空 → 默认勾选为空、可选群为空。
    expect(skill.selected).toEqual([]);
  });

  // 「发送测试」会把最近一场真实纪要发到群里：私密会议不能被选中（只有创建者能看）。
  it("会议纪要测试卡片只取公开会议的纪要", async () => {
    const u = await seedUser({ ssoId: "ou_nt" });
    const base = { createdById: u.id, allowedRoleIds: "[]", config: "{}", status: "ended" };
    await prisma.meetingSession.create({ data: { ...base, title: "公开周会", summaryMarkdown: "## 决策点\n公开内容", endedAt: new Date(Date.now() - 60_000) } });
    await prisma.meetingSession.create({ data: { ...base, title: "薪酬评审", visibility: "private", summaryMarkdown: "## 决策点\n私密内容", endedAt: new Date() } });
    const send = vi.fn(async (_chatId: string, _card: unknown) => ({ messageId: "m" }));
    await sendScenario("meeting_minutes", { send, targets: ["oc_a"] });
    const card = JSON.stringify(send.mock.calls[0]![1]);
    expect(card).toContain("公开周会");
    expect(card).not.toContain("薪酬评审");
    expect(card).not.toContain("私密内容");
  });

  it("sendScenario:注入目标群 + send,逐群发送并归集 messageId", async () => {
    const send = vi.fn(async (chatId: string, _card: unknown) => ({ messageId: `m-${chatId}` }));
    const { results } = await sendScenario("skill_updated", { send, targets: ["oc_a", "oc_b"] });
    expect(send).toHaveBeenCalledTimes(2);
    // 同一张卡片发到两个群。
    const card = send.mock.calls[0]![1] as { header: { title: { content: string } } };
    expect(card.header.title.content).toContain("Skill");
    expect(send.mock.calls[1]![1]).toBe(card);
    // 测试环境未配 FEISHU_CHAT_NAMES → name 回退为 chatId。
    expect(results).toEqual([
      { chatId: "oc_a", name: "oc_a", ok: true, messageId: "m-oc_a" },
      { chatId: "oc_b", name: "oc_b", ok: true, messageId: "m-oc_b" },
    ]);
  });

  it("sendScenario:单群失败只标在该条,不影响其它群", async () => {
    const send = vi.fn(async (chatId: string) => {
      if (chatId === "oc_bad") throw new Error("机器人不在群里");
      return { messageId: "ok" };
    });
    const { results } = await sendScenario("skill_updated", { send, targets: ["oc_bad", "oc_good"] });
    expect(results[0]).toMatchObject({ chatId: "oc_bad", ok: false, error: "机器人不在群里" });
    expect(results[1]).toMatchObject({ chatId: "oc_good", ok: true });
  });

  it("sendScenario:无目标群 → NoTargetError(提示勾选)", async () => {
    const err = await sendScenario("skill_updated", { targets: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(NoTargetError);
    expect((err as Error).message).toContain("未勾选目标群聊");
  });

  it("sendScenario:未知场景 → 抛错", async () => {
    await expect(sendScenario("nope", { targets: ["oc_x"] })).rejects.toThrow(/未知/);
  });

  it("startSendJob:立即返回 running,后台完成后可查询结果", async () => {
    const send = vi.fn(async (chatId: string, _card: unknown) => ({ messageId: `m-${chatId}` }));
    const job = startSendJob("skill_updated", { send, targets: ["oc_a"] });
    expect(job.status).toBe("running"); // POST 不等待执行
    expect(getSendJob(job.id)?.status).toBe("running");
    await job.promise;
    const done = getSendJob(job.id)!;
    expect(done.status).toBe("done");
    expect(done.ok).toBe(true);
    expect(done.results).toHaveLength(1);
  });

  it("startSendJob:执行抛错(如组卡片失败)→ done + error,不会悬挂", async () => {
    const job = startSendJob("nope", { targets: ["oc_a"] }); // 未知场景在任务内抛错
    await job.promise;
    const done = getSendJob(job.id)!;
    expect(done.status).toBe("done");
    expect(done.ok).toBe(false);
    expect(done.error).toContain("未知");
  });

  it("getSendJob:不存在 → null", () => {
    expect(getSendJob("nope-id")).toBeNull();
  });

  it("startSendJob:同场景已在执行 → AlreadyRunningError;完成后可再次发送", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const slowSend = vi.fn(async () => { await gate; return { messageId: "m" }; });
    const job = startSendJob("skill_updated", { send: slowSend, targets: ["oc_a"] });
    // 第一条还在执行(定时触发同理)→ 第二条被拒,避免双标签页/双管理员重复打扰群。
    expect(() => startSendJob("skill_updated", { send: slowSend, targets: ["oc_a"] }))
      .toThrow(AlreadyRunningError);
    releaseGate();
    await job.promise;
    // 完成释放运行标记后,可以再次发送。
    const job2 = startSendJob("skill_updated", { send: vi.fn(async () => ({ messageId: "m2" })), targets: ["oc_a"] });
    await job2.promise;
    expect(getSendJob(job2.id)?.ok).toBe(true);
  });
});
