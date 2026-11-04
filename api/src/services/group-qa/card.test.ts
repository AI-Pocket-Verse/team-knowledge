import { describe, it, expect } from "vitest";
import { buildGroupAnswerCard } from "./card.js";

interface Card {
  config: { wide_screen_mode: boolean };
  elements: Array<{ tag: string; text?: { content: string }; actions?: Array<{ text?: { content: string }; value?: { k?: string; h?: string }; url?: string }> }>;
}
const c = (card: unknown) => card as Card;
const text = (card: unknown) => c(card).elements.map((e) => e.text?.content ?? "").join("\n");
const actions = (card: unknown) => c(card).elements.find((e) => e.tag === "action")?.actions ?? [];

describe("buildGroupAnswerCard", () => {
  it("含引用首行 + 答案 + 来源 + 👎(带 demoteHash)+ 查看文档", () => {
    const card = buildGroupAnswerCard({
      quote: "报销流程怎么走",
      senderName: "张三",
      answer: "先在系统提交申请,主管审批后财务打款。",
      sourceTitle: "报销指南",
      sourceArticleId: "a1",
      hash: "h123",
      webBase: "https://kb.example.com/",
    });
    const t = text(card);
    expect(t).toContain("张三");
    expect(t).toContain("报销流程怎么走");
    expect(t).toContain("先在系统提交申请");
    expect(t).toContain("来源:《报销指南》");
    const acts = actions(card);
    const up = acts.find((a) => a.value?.k === "group_qa_up");
    const down = acts.find((a) => a.value?.k === "group_qa_down");
    expect(up?.value?.h).toBe("h123"); // 👍 有帮助,带问题指纹
    expect(down?.value?.h).toBe("h123"); // 👎 没帮助,同指纹
    const view = acts.find((a) => a.url);
    expect(view?.url).toBe("https://kb.example.com/d/a1");
  });

  it("无来源/无 webBase → 不出来源行与查看文档按钮", () => {
    const card = buildGroupAnswerCard({ quote: "x", answer: "y", hash: "h" });
    expect(text(card)).not.toContain("来源");
    expect(actions(card).some((a) => a.url)).toBe(false);
    expect(actions(card).map((a) => a.value?.k)).toEqual(["group_qa_up", "group_qa_down"]);
  });

  it("过长引用截断;用户文本去链接(delink)防注入", () => {
    const long = "很长".repeat(50);
    const card = buildGroupAnswerCard({ quote: long, answer: "a", hash: "h", senderName: "[x](http://evil)" });
    const t = text(card);
    expect(t).toContain("…"); // 引用被截断
    // delinkLarkMd 把半角方括号换成全角 → [x](url) 不再是可点链接(语法被破坏)
    expect(t).not.toContain("[x](");
    expect(t).toContain("［x］");
  });

  it("尖括号内联标签(<at>/<font>)转全角,防 @所有人 / 样式注入", () => {
    const card = buildGroupAnswerCard({ quote: "<at id=all></at>报销", answer: "<font color=red>注入</font>", hash: "h" });
    const t = text(card);
    // 用户/LLM 文本里的尖括号被换成全角(我们自己包的是 <font color='grey'>,不含 <at)
    expect(t).not.toContain("<at id=all>");
    expect(t).toContain("＜at id=all＞");
    expect(t).toContain("＜font color=red＞注入＜/font＞");
  });
});
