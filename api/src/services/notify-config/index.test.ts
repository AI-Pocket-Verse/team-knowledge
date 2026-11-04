import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// mock env:提供两个可选群(oc_a 命名为 A群,oc_b 只出现在场景默认里),便于验证
// 勾选校验 / 孤儿群交集。测试内可直接改写这些字段模拟「env 变更后重启」。
vi.mock("../../env.js", () => ({
  AUTH_API_BASE: "http://auth.invalid/api",
  env: {
    FEISHU_SKILL_NOTIFY_CHAT_IDS: "oc_a,oc_b",
    FEISHU_WEEKLY_DIGEST_CHAT_IDS: "oc_a,oc_b",
    FEISHU_MEETING_NOTIFY_CHAT_IDS: "",
    FEISHU_DOC_AUDIT_NOTIFY_CHAT_IDS: "",
    FEISHU_CHANGELOG_NOTIFY_CHAT_IDS: "",
    FEISHU_KB_WEEKLY_REPORT_CHAT_IDS: "",
    FEISHU_CHAT_NAMES: "oc_a=A群",
    INTERNAL_API_TOKEN: "t",
    WEB_PUBLIC_URL: "http://gw.invalid/kb",
    FEISHU_CARD_USE_APPLINK: false,
    ADMIN_OPEN_IDS: "",
    ADMIN_EMAILS: "",
    ADMIN_PHONES: "",
    NOTIFY_INCLUDE_SELF: false,
  },
}));

import { env } from "../../env.js";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import {
  availableChats, chatLabel, getScenarioNotifyConfig, setScenarioNotifyConfig, targetsIfEnabled,
} from "./index.js";

type MutEnv = Record<string, string | boolean>;

describe("notify-config(每场景独立存储)", () => {
  beforeEach(async () => {
    await resetDb();
    (env as unknown as MutEnv).FEISHU_SKILL_NOTIFY_CHAT_IDS = "oc_a,oc_b";
    (env as unknown as MutEnv).FEISHU_WEEKLY_DIGEST_CHAT_IDS = "oc_a,oc_b";
    (env as unknown as MutEnv).FEISHU_CHAT_NAMES = "oc_a=A群";
  });
  afterAll(async () => { await disconnectDb(); });

  it("availableChats:命名群 ∪ 各场景 env 默认;chatLabel 回退 id", () => {
    const ids = availableChats().map((c) => c.chatId).sort();
    expect(ids).toEqual(["oc_a", "oc_b"]);
    expect(chatLabel("oc_a")).toBe("A群");
    expect(chatLabel("oc_b")).toBe("oc_b");
  });

  it("默认配置:enabled=false(自动任务须显式开启),chatIds=env 默认(全选)", async () => {
    const c = await getScenarioNotifyConfig("skill_updated");
    expect(c).toEqual({ enabled: false, chatIds: ["oc_a", "oc_b"], schedule: null });
    // 默认关闭 → 自动任务拿不到目标群
    expect(await targetsIfEnabled("skill_updated")).toEqual([]);
  });

  it("并发 PATCH 不同场景互不覆盖(每场景独立 Setting 行)", async () => {
    await Promise.all([
      setScenarioNotifyConfig("skill_updated", { enabled: true }, "u1"),
      setScenarioNotifyConfig("weekly_digest", { chatIds: ["oc_a"] }, "u1"),
    ]);
    expect((await getScenarioNotifyConfig("skill_updated")).enabled).toBe(true);
    expect((await getScenarioNotifyConfig("weekly_digest")).chatIds).toEqual(["oc_a"]);
    // 各自的另一字段不受影响(enabled 仍是默认关)
    expect((await getScenarioNotifyConfig("skill_updated")).chatIds).toEqual(["oc_a", "oc_b"]);
    expect((await getScenarioNotifyConfig("weekly_digest")).enabled).toBe(false);
  });

  it("同场景先后 PATCH 两个字段:事务合并,后写不丢前写", async () => {
    await setScenarioNotifyConfig("skill_updated", { enabled: true }, "u1");
    await setScenarioNotifyConfig("skill_updated", { chatIds: ["oc_b"] }, "u1");
    expect(await getScenarioNotifyConfig("skill_updated")).toEqual({ enabled: true, chatIds: ["oc_b"], schedule: null });
  });

  it("旧版合并行只读回退,首次写入时迁移到独立行", async () => {
    await prisma.setting.create({
      data: { key: "feishu-notify.config", value: JSON.stringify({ skill_updated: { enabled: false, chatIds: ["oc_a"] } }), updatedBy: "legacy" },
    });
    // 读:回退到旧行
    expect(await getScenarioNotifyConfig("skill_updated")).toEqual({ enabled: false, chatIds: ["oc_a"], schedule: null });
    // 写:迁移旧值 + 合并补丁 → 独立行
    await setScenarioNotifyConfig("skill_updated", { chatIds: ["oc_b"] }, "u1");
    expect(await getScenarioNotifyConfig("skill_updated")).toEqual({ enabled: false, chatIds: ["oc_b"], schedule: null });
    const own = await prisma.setting.findUnique({ where: { key: "feishu-notify.scenario.skill_updated" } });
    expect(own).toBeTruthy();
  });

  it("勾选未知群 → 拒绝", async () => {
    await expect(setScenarioNotifyConfig("skill_updated", { chatIds: ["oc_evil"] }, "u1")).rejects.toThrow(/未知的群聊/);
  });

  it("孤儿群:已存勾选的群从 env 移除后,读取即剔除(停发且不卡死后续保存)", async () => {
    await setScenarioNotifyConfig("skill_updated", { enabled: true, chatIds: ["oc_a", "oc_b"] }, "u1");
    // 模拟运维把 oc_b 从【所有】env 名单移除后重启(仍出现在任一场景默认里则
    // 视为「已知群」继续保留 —— 那不是孤儿)。
    (env as unknown as MutEnv).FEISHU_SKILL_NOTIFY_CHAT_IDS = "oc_a";
    (env as unknown as MutEnv).FEISHU_WEEKLY_DIGEST_CHAT_IDS = "oc_a";
    expect((await getScenarioNotifyConfig("skill_updated")).chatIds).toEqual(["oc_a"]); // oc_b 被剔除
    expect(await targetsIfEnabled("skill_updated")).toEqual(["oc_a"]); // 自动任务同样不再发 oc_b
    // 后续保存不被孤儿 id 卡死
    await expect(setScenarioNotifyConfig("skill_updated", { chatIds: ["oc_a"] }, "u1")).resolves.toBeTruthy();
  });

  it("targetsIfEnabled:任务关闭 → 空数组", async () => {
    await setScenarioNotifyConfig("skill_updated", { enabled: false }, "u1");
    expect(await targetsIfEnabled("skill_updated")).toEqual([]);
  });
});

describe("定时触发时刻(schedule)", () => {
  beforeEach(async () => { await resetDb(); });

  it("默认值 / 持久化 / 归一化(去重排序);event 类无 schedule 且不可配置", async () => {
    // 没存过 → 默认(周五 21:00,每周重复);event 类为 null。
    expect((await getScenarioNotifyConfig("weekly_digest")).schedule)
      .toEqual({ weekdays: [5], hour: 21, minute: 0, repeat: true });
    expect((await getScenarioNotifyConfig("skill_updated")).schedule).toBeNull();

    // 写入(乱序 + 重复的星期)→ 去重排序后落库,回读一致。
    const set = await setScenarioNotifyConfig(
      "weekly_digest",
      { schedule: { weekdays: [3, 1, 3], hour: 8, minute: 30, repeat: false } },
      "admin",
    );
    expect(set.schedule).toEqual({ weekdays: [1, 3], hour: 8, minute: 30, repeat: false });
    expect((await getScenarioNotifyConfig("weekly_digest")).schedule)
      .toEqual({ weekdays: [1, 3], hour: 8, minute: 30, repeat: false });

    // event 类任务配置 schedule → 拒绝。
    await expect(
      setScenarioNotifyConfig("skill_updated", { schedule: { weekdays: [1], hour: 9, minute: 0, repeat: true } }, "admin"),
    ).rejects.toThrow(/不支持/);
  });
});
