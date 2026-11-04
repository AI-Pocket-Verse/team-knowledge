import { describe, it, expect, vi } from "vitest";

// notify.ts 经 feishuGateway 间接 import env(其模块顶层还解构 AUTH_API_BASE),
// 一并 mock 掉,避免真实 env 校验介入。目标群一律注入 getTargets(单测不读 DB 配置)。
vi.mock("../../env.js", () => ({
  AUTH_API_BASE: "http://auth.invalid/api",
  env: {
    APP_LANGUAGE: "zh",
    INTERNAL_API_TOKEN: "t",
    WEB_PUBLIC_URL: "http://gw.invalid/kb",
    FEISHU_CARD_USE_APPLINK: false,
  },
}));

import { notifySkillUpdated, buildSkillUpdatedCard, fmtBeijing } from "./notify.js";

const GEN_AT = new Date("2026-06-10T07:05:00Z"); // 北京时间 15:05
// 组卡片入参(变更摘要已算好)。
const CARD = { roleId: "role-1", roleName: "后端工程师", docCount: 12, model: "claude", generatedAt: GEN_AT, changeSummary: null };
// notifySkillUpdated 入参(带新旧 skill.md,内部算摘要)。
const NOTIFY = { roleId: "role-1", roleName: "后端工程师", docCount: 12, model: "claude", generatedAt: GEN_AT, prevContent: "旧 skill", newContent: "新 skill" };
// 注入的目标群解析器(替代默认的「读后台配置」)。
const targets = (ids: string[]) => async () => ids;

describe("role-skill notify (app bot → group chat)", () => {
  it("fmtBeijing renders yyyy-MM-dd HH:mm in Asia/Shanghai", () => {
    expect(fmtBeijing(GEN_AT)).toBe("2026-06-10 15:05");
  });

  it("card carries role name, doc count, model and Beijing time (validCard shape)", () => {
    const card = buildSkillUpdatedCard(CARD) as { header: unknown; elements: Array<{ text: { content: string } }> };
    expect(Object.keys(card).sort()).toEqual(["config", "elements", "header"]);
    const text = card.elements[0]!.text.content;
    expect(text).toContain("后端工程师");
    expect(text).toContain("12 篇");
    expect(text).not.toContain("截断"); // 截断细节不再出现在通知卡片
    expect(text).toContain("claude");
    expect(text).toContain("2026-06-10 15:05");
    // 跳转角色主页按钮(/r/:roleId)
    const action = (card.elements as unknown as Array<{ tag: string; actions?: Array<{ url: string; text: { content: string } }> }>).find((e) => e.tag === "action");
    expect(action?.actions?.[0]?.text.content).toBe("查看角色");
    expect(action?.actions?.[0]?.url).toBe("http://gw.invalid/kb/r/role-1");
  });

  it("本次更新段:展示变更摘要 / 首次生成", () => {
    const withSummary = buildSkillUpdatedCard({ ...CARD, changeSummary: "补充了「权限申请」能力,移除了旧登录流程。" }) as { elements: Array<{ text?: { content: string } }> };
    const t1 = withSummary.elements.map((e) => e.text?.content ?? "").join("\n");
    expect(t1).toContain("本次更新");
    expect(t1).toContain("补充了「权限申请」能力");

    const first = buildSkillUpdatedCard({ ...CARD, changeSummary: null }) as { elements: Array<{ text?: { content: string } }> };
    expect(first.elements.map((e) => e.text?.content ?? "").join("\n")).toContain("首次生成");
  });

  it("notify:对比新旧 skill.md 得摘要 → 卡片含摘要,并发到配置的群", async () => {
    const send = vi.fn(async () => ({ messageId: "om_1" }));
    const summarize = vi.fn(async () => "调整了语气与示例。");
    await notifySkillUpdated(NOTIFY, send, summarize, targets(["oc_test_group"]));
    expect(summarize).toHaveBeenCalledWith("旧 skill", "新 skill");
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, card] = send.mock.calls[0] as unknown as [string, { header: unknown; elements: Array<{ text?: { content: string } }> }];
    expect(chatId).toBe("oc_test_group");
    expect(card.elements.map((e) => e.text?.content ?? "").join("\n")).toContain("调整了语气与示例。");
  });

  it("notify:首次生成(无上一版)不调用摘要器,显示首次生成", async () => {
    const send = vi.fn(async () => ({ messageId: "om_1" }));
    const summarize = vi.fn(async () => "不该被调用");
    await notifySkillUpdated({ ...NOTIFY, prevContent: "" }, send, summarize, targets(["oc_test_group"]));
    expect(summarize).not.toHaveBeenCalled();
    const [, card] = send.mock.calls[0] as unknown as [string, { elements: Array<{ text?: { content: string } }> }];
    expect(card.elements.map((e) => e.text?.content ?? "").join("\n")).toContain("首次生成");
  });

  it("notify:摘要器失败(返回 null)→ 兜底文案", async () => {
    const send = vi.fn(async () => ({ messageId: "om_1" }));
    const summarize = vi.fn(async () => null);
    await notifySkillUpdated(NOTIFY, send, summarize, targets(["oc_test_group"]));
    const [, card] = send.mock.calls[0] as unknown as [string, { elements: Array<{ text?: { content: string } }> }];
    expect(card.elements.map((e) => e.text?.content ?? "").join("\n")).toContain("变更摘要暂不可用");
  });

  it("notify:配置多个群 → 同一张卡片发到每个群,单群失败不影响其它群", async () => {
    const warn = vi.fn();
    const send = vi.fn(async (chatId: string) => {
      if (chatId === "oc_b") throw new Error("机器人不在群");
      return { messageId: "om_1" };
    });
    const summarize = vi.fn(async () => "x");
    await notifySkillUpdated({ ...NOTIFY, log: { warn } }, send, summarize, targets(["oc_a", "oc_b"]));
    expect(send.mock.calls.map((c) => c[0])).toEqual(["oc_a", "oc_b"]);
    expect(warn).toHaveBeenCalledTimes(1); // 仅 oc_b 失败被记一次
  });

  it("无目标群(任务关闭或未勾选)→ 不发送", async () => {
    const send = vi.fn();
    const summarize = vi.fn();
    await notifySkillUpdated(NOTIFY, send, summarize, targets([]));
    expect(send).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("swallows gateway errors and logs a warning (fire-and-forget)", async () => {
    const warn = vi.fn();
    const send = vi.fn(async () => { throw new Error("feishu_upstream"); });
    const summarize = vi.fn(async () => "x");
    await expect(notifySkillUpdated({ ...NOTIFY, log: { warn } }, send, summarize, targets(["oc_test_group"]))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
