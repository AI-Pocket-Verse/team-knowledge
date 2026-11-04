import { describe, it, expect, vi, beforeEach } from "vitest";

// fireJob 直连真实模块 —— 全部 mock 掉,只验证编排:开关/目标群门禁、逐群
// best-effort 发送、运行中标记的生命周期。
const { notifyChat, getCfg, setCfg, buildDigest } = vi.hoisted(() => ({
  notifyChat: vi.fn(async () => ({ messageId: "om_1" })),
  getCfg: vi.fn(),
  setCfg: vi.fn(async () => ({})),
  buildDigest: vi.fn(async () => ({ card: { elements: [{ tag: "div" }] } })),
}));
vi.mock("../../utils/feishuGateway.js", () => ({ feishuGateway: { notifyChat } }));
vi.mock("../role-digest/run.js", () => ({ generateWeeklyDigest: buildDigest }));
vi.mock("../doc-audit/run.js", () => ({ runDocAudit: vi.fn(async () => ({ card: {} })) }));
vi.mock("../backup.js", () => ({ isRestoring: () => false }));
vi.mock("../notify-config/index.js", () => ({
  getScenarioNotifyConfig: getCfg,
  setScenarioNotifyConfig: setCfg,
  chatLabel: (id: string) => id,
  DEFAULT_SCHEDULES: {
    weekly_digest: { weekdays: [5], hour: 21, minute: 0, repeat: true },
    doc_audit: { weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0, repeat: true },
  },
}));

import { __testing, startNotifyCronScheduler, rescheduleNotifyCron } from "./index.js";
import { msUntilNextBeijing } from "../../utils/beijingWeek.js";
import { scenarioRunningSince, clearAllRunning } from "../notify-test/running.js";

const weeklyJob = __testing.JOBS.find((j) => j.key === "weekly_digest")!;

describe("notify-cron fireJob", () => {
  beforeEach(() => {
    notifyChat.mockClear();
    buildDigest.mockClear();
    getCfg.mockReset();
    setCfg.mockClear();
    clearAllRunning();
  });

  it("自动任务关闭 → 不组卡不发送", async () => {
    getCfg.mockResolvedValue({ enabled: false, chatIds: ["oc_1"] });
    await __testing.fireJob(weeklyJob);
    expect(buildDigest).not.toHaveBeenCalled();
    expect(notifyChat).not.toHaveBeenCalled();
  });

  it("未勾选目标群 → 跳过", async () => {
    getCfg.mockResolvedValue({ enabled: true, chatIds: [] });
    await __testing.fireJob(weeklyJob);
    expect(notifyChat).not.toHaveBeenCalled();
  });

  it("开启 + 两个群 → 组卡一次、逐群发送;执行期间 running 标记可见,结束后清除", async () => {
    getCfg.mockResolvedValue({ enabled: true, chatIds: ["oc_1", "oc_2"] });
    // 组卡阶段断言运行中标记已点亮(控制台轮询此时能看到「运行中」)。
    buildDigest.mockImplementationOnce(async () => {
      expect(scenarioRunningSince("weekly_digest")).not.toBeNull();
      return { card: { elements: [] } };
    });
    await __testing.fireJob(weeklyJob);
    expect(notifyChat).toHaveBeenCalledTimes(2);
    expect(scenarioRunningSince("weekly_digest")).toBeNull();
  });

  it("repeat=false(仅执行一次):实际执行后自动停用;repeat=true 不停用", async () => {
    getCfg.mockResolvedValue({
      enabled: true, chatIds: ["oc_1"],
      schedule: { weekdays: [5], hour: 21, minute: 0, repeat: false },
    });
    await __testing.fireJob(weeklyJob);
    expect(setCfg).toHaveBeenCalledWith("weekly_digest", { enabled: false }, "system:notify-cron");

    setCfg.mockClear();
    getCfg.mockResolvedValue({
      enabled: true, chatIds: ["oc_1"],
      schedule: { weekdays: [5], hour: 21, minute: 0, repeat: true },
    });
    await __testing.fireJob(weeklyJob);
    expect(setCfg).not.toHaveBeenCalled();
  });

  it("repeat=false 但任务关闭/无目标群:跳过且不消耗单次配置", async () => {
    getCfg.mockResolvedValue({
      enabled: false, chatIds: ["oc_1"],
      schedule: { weekdays: [5], hour: 21, minute: 0, repeat: false },
    });
    await __testing.fireJob(weeklyJob);
    expect(notifyChat).not.toHaveBeenCalled();
    expect(setCfg).not.toHaveBeenCalled();
  });

  it("单群发送失败不影响其它群,任务不抛出", async () => {
    getCfg.mockResolvedValue({ enabled: true, chatIds: ["oc_bad", "oc_ok"] });
    notifyChat.mockRejectedValueOnce(new Error("230002 bot not in chat"));
    await expect(__testing.fireJob(weeklyJob)).resolves.toBe(true);
    expect(notifyChat).toHaveBeenCalledTimes(2);
    expect(scenarioRunningSince("weekly_digest")).toBeNull();
  });

  it("重叠的重排(armJob)不泄漏旧定时器 → 到点只触发一次,不会群里收两条", async () => {
    // 复现:armJob 在 clearTimeout 与 timers.set 之间 await 读配置;启动时的
    // armJob 与两次 rescheduleNotifyCron 重叠,泄漏的旧定时器会让同一任务双发。
    vi.useFakeTimers();
    try {
      const SCHED = { weekdays: [5], hour: 21, minute: 0, repeat: true };
      getCfg.mockImplementation(async (key: string) =>
        key === "weekly_digest"
          ? { enabled: true, chatIds: ["oc_1"], schedule: SCHED }
          : { enabled: false, chatIds: [], schedule: null }, // doc_audit 不参与(不会被 arm)
      );
      const stop = startNotifyCronScheduler();
      rescheduleNotifyCron("weekly_digest"); // 与启动时的 armJob 重叠
      rescheduleNotifyCron("weekly_digest");
      await vi.advanceTimersByTimeAsync(0); // 让三个 armJob 的配置读取都回来、定时器就位
      notifyChat.mockClear();

      const delay = msUntilNextBeijing(SCHED.weekdays, SCHED.hour, SCHED.minute, new Date());
      await vi.advanceTimersByTimeAsync(delay + 1000); // 越过触发时刻(再触发已是 +7 天,窗口外)
      stop();
      expect(notifyChat).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
