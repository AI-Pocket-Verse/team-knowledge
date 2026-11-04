import { describe, it, expect, beforeEach } from "vitest";
import {
  looksLikeQuestion, questionHash,
  cooldownOk, hourlyOk, notAnsweredRecently, markAnswered, _resetGate,
} from "./gate.js";

beforeEach(() => _resetGate());

describe("looksLikeQuestion", () => {
  it("问号 / 疑问词 → true", () => {
    expect(looksLikeQuestion("报销流程是什么意思")).toBe(true);
    expect(looksLikeQuestion("这个怎么弄")).toBe(true);
    expect(looksLikeQuestion("能不能给个文档")).toBe(true);
    expect(looksLikeQuestion("有没有人知道")).toBe(true);
    expect(looksLikeQuestion("在哪个页面?")).toBe(true);
  });
  it("表示疑问的陈述句(无问号)也放行 —— 「不明确的问题」", () => {
    expect(looksLikeQuestion("报销流程我一直没搞清楚")).toBe(true);
    expect(looksLikeQuestion("登录老是失败")).toBe(true);
    expect(looksLikeQuestion("这个我不太清楚")).toBe(true);
    expect(looksLikeQuestion("谁知道审批在哪配置")).toBe(true);
    expect(looksLikeQuestion("页面打不开")).toBe(true);
  });
  it("索取 / 请求资料(祈使句,无问号)也放行", () => {
    expect(looksLikeQuestion("会员协议发我一下")).toBe(true);
    expect(looksLikeQuestion("给我份接入文档")).toBe(true);
    expect(looksLikeQuestion("sql 脚本谁有")).toBe(true);
    expect(looksLikeQuestion("隐私政策分享一下")).toBe(true);
    expect(looksLikeQuestion("想要一份测试用例")).toBe(true);
  });
  it("求证 / 推测陈述(带语气词,无问号)也放行", () => {
    expect(looksLikeQuestion("sql脚本应该包含全部建表语句吧")).toBe(true);
    expect(looksLikeQuestion("隐私协议需要这几个SDK对吧")).toBe(true);
  });
  it("纯闲聊 / 应答 / 空 → false", () => {
    expect(looksLikeQuestion("我下班了")).toBe(false);
    expect(looksLikeQuestion("好的收到")).toBe(false);
    expect(looksLikeQuestion("哈哈哈")).toBe(false);
    expect(looksLikeQuestion("   ")).toBe(false);
  });
});

describe("questionHash", () => {
  it("忽略空白/标点/大小写,语义相同 → 同 hash", () => {
    expect(questionHash("报销 流程 怎么 走?")).toBe(questionHash("报销流程怎么走"));
    expect(questionHash("ABC")).toBe(questionHash("a b c"));
  });
  it("不同问题 → 不同 hash", () => {
    expect(questionHash("报销流程")).not.toBe(questionHash("入职流程"));
  });
});

describe("限频 / 去重(时间注入)", () => {
  it("cooldown:回答后 45s 内不可再答,之后可", () => {
    const t0 = 1_000_000;
    expect(cooldownOk("c1", t0)).toBe(true);
    markAnswered("c1", "h1", t0);
    expect(cooldownOk("c1", t0 + 30_000)).toBe(false);
    expect(cooldownOk("c1", t0 + 45_000)).toBe(true);
    // 别的群不受影响
    expect(cooldownOk("c2", t0 + 1)).toBe(true);
  });

  it("hourly:每群每小时上限 6 次", () => {
    const base = 5_000_000;
    for (let i = 0; i < 6; i++) {
      expect(hourlyOk("c1", base + i * 1000)).toBe(true);
      markAnswered("c1", `h${i}`, base + i * 1000);
    }
    expect(hourlyOk("c1", base + 7000)).toBe(false); // 第 7 次被挡
    expect(hourlyOk("c1", base + 3_600_001)).toBe(true); // 一小时后窗口滑出
  });

  it("answered:同一问题 30 分钟内不重复答", () => {
    const t0 = 9_000_000;
    const h = questionHash("报销流程怎么走");
    expect(notAnsweredRecently(h, t0)).toBe(true);
    markAnswered("c1", h, t0);
    expect(notAnsweredRecently(h, t0 + 10 * 60_000)).toBe(false);
    expect(notAnsweredRecently(h, t0 + 30 * 60_000)).toBe(true);
  });
});
