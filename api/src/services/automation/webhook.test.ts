import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverToFeishu, isAllowedWebhook, buildFeishuPayload, markdownToLarkMd } from "./webhook.js";

describe("automation webhook", () => {
  it("isAllowedWebhook:仅飞书/Lark 机器人 webhook 域", () => {
    expect(isAllowedWebhook("https://open.feishu.cn/open-apis/bot/v2/hook/abc-123")).toBe(true);
    expect(isAllowedWebhook("https://open.larksuite.com/open-apis/bot/v2/hook/abc")).toBe(true);
    expect(isAllowedWebhook("http://open.feishu.cn/open-apis/bot/v2/hook/abc")).toBe(false); // 非 https
    expect(isAllowedWebhook("https://evil.com/open-apis/bot/v2/hook/abc")).toBe(false);       // 非白名单域
    expect(isAllowedWebhook("https://open.feishu.cn/other/path")).toBe(false);                // 非 hook 路径
    expect(isAllowedWebhook("not a url")).toBe(false);
  });

  it("buildFeishuPayload:带 msg_type 的完整体直接用", () => {
    const out = "```json\n" + JSON.stringify({ msg_type: "interactive", card: { header: {}, elements: [] } }) + "\n```";
    expect(buildFeishuPayload(out)).toEqual({ msg_type: "interactive", card: { header: {}, elements: [] } });
  });

  it("buildFeishuPayload:卡片对象(无 msg_type)包一层 interactive", () => {
    const out = "前面一段说明\n" + JSON.stringify({ header: { title: "x" }, elements: [{ tag: "div" }] }) + "\n后面";
    expect(buildFeishuPayload(out)).toEqual({ msg_type: "interactive", card: { header: { title: "x" }, elements: [{ tag: "div" }] } });
  });

  it("buildFeishuPayload:无 JSON → 退化成 lark_md 卡片(而非原始 markdown 纯文本)", () => {
    const out = buildFeishuPayload("纯文本没有大括号");
    expect(out.msg_type).toBe("interactive");
    const card = out.card as { elements: { text: { tag: string; content: string } }[] };
    expect(card.elements[0].text.tag).toBe("lark_md");
    expect(card.elements[0].text.content).toBe("纯文本没有大括号");
  });

  it("markdownToLarkMd:标题→加粗、列表→圆点,保留行内加粗/链接", () => {
    const md = "# 今日 AI 动态\n**日期**:2026-07-06\n## 突破\n- 条目一\n[标题](https://x.com/p/1)";
    expect(markdownToLarkMd(md)).toBe(
      "**今日 AI 动态**\n**日期**:2026-07-06\n**突破**\n• 条目一\n[标题](https://x.com/p/1)",
    );
  });

  it("markdownToLarkMd:空标题不产生 ****;已加粗标题不重复包裹", () => {
    expect(markdownToLarkMd("# ")).toBe("");                    // 空标题 → 空行,而非 ****
    expect(markdownToLarkMd("## **已加粗**")).toBe("**已加粗**"); // 不再变成 ****已加粗****
  });

  it("buildFeishuPayload:空产出 → lark_md 内容兜底为(无内容)", () => {
    const out = buildFeishuPayload("   \n  ");
    const card = out.card as { elements: { text: { content: string } }[] };
    expect(card.elements[0].text.content).toBe("(无内容)");
  });

  it("buildFeishuPayload:忽略嵌套字符串里的假括号,取真正可解析的对象", () => {
    const out = `注意 "a{b}c" 不是对象\n${JSON.stringify({ msg_type: "text", content: { text: "hi" } })}`;
    expect(buildFeishuPayload(out)).toEqual({ msg_type: "text", content: { text: "hi" } });
  });

  it("buildFeishuPayload:散文里含无关对象 + 末尾真正卡片 → 取像飞书体的那个", () => {
    const out = `我先分析:{"note":"这是示例,不是卡片"} 然后给出结果:\n`
      + JSON.stringify({ msg_type: "interactive", card: { header: { title: "t" }, elements: [] } });
    expect(buildFeishuPayload(out)).toEqual({ msg_type: "interactive", card: { header: { title: "t" }, elements: [] } });
  });
});

describe("deliverToFeishu 确定性失败标记", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const HOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";

  it("域不合法 → retryable=false", async () => {
    const r = await deliverToFeishu("https://evil.com/x", "hi");
    expect(r).toMatchObject({ ok: false, retryable: false });
  });

  it("4xx(非 429)→ retryable=false,且只请求一次", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", f);
    const r = await deliverToFeishu(HOOK, "hi");
    expect(r).toMatchObject({ ok: false, httpStatus: 400, retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
