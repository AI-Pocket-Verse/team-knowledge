import { describe, it, expect, vi } from "vitest";

// notify.ts(及其 import 的 card.ts / role-skill notify 的 fmtBeijing)间接 import env,
// 一并 mock 掉,避免真实 env 校验介入。目标群一律注入 getTargets(单测不读 DB 配置)。
vi.mock("../../env.js", () => ({
  AUTH_API_BASE: "http://auth.invalid/api",
  env: {
    INTERNAL_API_TOKEN: "t",
    WEB_PUBLIC_URL: "http://gw.invalid/kb",
    FEISHU_CARD_USE_APPLINK: false,
  },
}));

import { buildMeetingMinutesCard, notifyMeetingMinutes, minutesToLarkMd } from "./notify.js";

// 注入的目标群解析器(替代默认的「读后台配置」)。
const targets = (ids: string[]) => async () => ids;

const GEN_AT = new Date("2026-06-10T07:05:00Z"); // 北京 15:05
const MINUTES = "## 决策点\n1. 上线登录\n\n## 待办事项\n1. 张三:补测试";
const ARGS = { meetingId: "m-1", title: "产品评审会", summaryMarkdown: MINUTES, generatedAt: GEN_AT, visibility: "public" };

const cardText = (card: unknown) =>
  (card as { elements: Array<{ text?: { content: string } }> }).elements.map((e) => e.text?.content ?? "").join("\n");

describe("meeting minutes notify (app bot → group chat)", () => {
  it("minutesToLarkMd:## 标题转加粗", () => {
    expect(minutesToLarkMd("## 决策点\n内容")).toBe("**决策点**\n内容");
  });

  it("minutesToLarkMd:超长截断并提示见链接", () => {
    const long = "x".repeat(2000);
    const out = minutesToLarkMd(long);
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("点下方按钮查看完整内容");
  });

  it("卡片:标题 / 纪要正文(转加粗)/ 生成时间 / 查看会议纪要按钮(/meeting/:id)", () => {
    const card = buildMeetingMinutesCard(ARGS) as { header: { title: { content: string } }; elements: Array<{ tag: string; text?: { content: string }; actions?: Array<{ url: string; text: { content: string } }> }> };
    expect(Object.keys(card).sort()).toEqual(["config", "elements", "header"]);
    expect(card.header.title.content).toContain("会议纪要");
    const text = cardText(card);
    expect(text).toContain("产品评审会");
    expect(text).toContain("**决策点**"); // ## → 加粗
    expect(text).toContain("2026-06-10 15:05");
    const action = card.elements.find((e) => e.tag === "action");
    expect(action?.actions?.[0]?.text.content).toBe("查看会议纪要");
    expect(action?.actions?.[0]?.url).toBe("http://gw.invalid/kb/meeting/m-1");
  });

  it("卡片:会议标题里的方括号被全角化,无法拼出可点击链接", () => {
    const card = buildMeetingMinutesCard({ ...ARGS, title: "[点我](http://evil.example) 评审会" });
    const text = cardText(card);
    expect(text).toContain("［点我］(http://evil.example) 评审会");
    expect(text).not.toContain("[点我](");
  });

  it("notify:多群发送,单群失败不影响其它群", async () => {
    const warn = vi.fn();
    const send = vi.fn(async (chatId: string) => {
      if (chatId === "oc_b") throw new Error("机器人不在群");
      return { messageId: "om_1" };
    });
    await notifyMeetingMinutes({ ...ARGS, log: { warn } }, send, targets(["oc_a", "oc_b"]));
    expect(send.mock.calls.map((c) => c[0])).toEqual(["oc_a", "oc_b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("notify:无目标群(任务关闭或未勾选)→ 不发送", async () => {
    const send = vi.fn();
    await notifyMeetingMinutes(ARGS, send, targets([]));
    expect(send).not.toHaveBeenCalled();
  });

  it("notify:开关关着时不消耗一次性认领(claim 在目标群检查之后才执行)", async () => {
    const claim = vi.fn(async () => true);
    const send = vi.fn();
    await notifyMeetingMinutes({ ...ARGS, claim }, send, targets([]));
    expect(claim).not.toHaveBeenCalled(); // 认领保留 → 之后开启再重新生成仍能播报
    expect(send).not.toHaveBeenCalled();
  });

  it("notify:认领成功 → 发送;认领失败(已播报过)→ 不发送", async () => {
    const send = vi.fn(async () => ({ messageId: "om" }));
    await notifyMeetingMinutes({ ...ARGS, claim: async () => true }, send, targets(["oc_a"]));
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    await notifyMeetingMinutes({ ...ARGS, claim: async () => false }, send, targets(["oc_a"]));
    expect(send).not.toHaveBeenCalled();
  });
});
