// 群聊智能答疑的「回复卡片」(纯函数)。紧凑形态:首行引用原话 + 简短答案 +(可选)
// 来源 + 一行操作(👎 没帮助 / 可选 查看文档)。键限定 config/elements 以过 feishu-sso 端
// validCard(1.0)校验。用户/LLM 文本一律过 delinkLarkMd,杜绝拼出可点链接 / @所有人。
import { delinkLarkMd } from "../../utils/notify/card.js";

// 进 lark_md 的不可信文本(群里原话 / 发送人名 / LLM 答案 / 文档标题)统一净化:
// delinkLarkMd 去方括号(挡 [文字](URL) 链接),再把尖括号换全角,挡 <at id=all>/<font>
// 等内联标签注入(以及用 </font> 提前闭合我们自己包的灰字 font)。
function safeMd(s: string): string {
  return delinkLarkMd(s).replace(/</g, "＜").replace(/>/g, "＞");
}

export interface GroupAnswerCardArgs {
  /** 原消息文本(会截断到一行)。 */
  quote: string;
  senderName?: string;
  /** 简短答案(已截断)。 */
  answer: string;
  sourceTitle?: string;
  sourceArticleId?: string;
  /** 反馈用的问题指纹(👍/👎 按钮带回;👎 触发反对降权)。 */
  hash: string;
  /** 知识库网页根地址,用于「查看文档」按钮;无则不出该按钮。 */
  webBase?: string;
  /** 生成本答案的模型显示名(curated);仅当后台开启「群卡片显示模型」时传入。 */
  model?: string;
}

const QUOTE_CAP = 40;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function buildGroupAnswerCard(a: GroupAnswerCardArgs): unknown {
  const who = a.senderName ? `${safeMd(a.senderName)}: ` : "";
  const quoteLine = `<font color='grey'>📌 ${who}${safeMd(clip(a.quote, QUOTE_CAP))}</font>`;
  const elements: Array<Record<string, unknown>> = [
    { tag: "div", text: { tag: "lark_md", content: quoteLine } },
    { tag: "div", text: { tag: "lark_md", content: safeMd(a.answer) } },
  ];
  if (a.sourceTitle) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: `<font color='grey'>来源:《${safeMd(a.sourceTitle)}》</font>` } });
  }
  if (a.model) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: `<font color='grey'>模型:${safeMd(a.model)}</font>` } });
  }
  const actions: Array<Record<string, unknown>> = [
    { tag: "button", text: { tag: "plain_text", content: "👍 有帮助" }, type: "default", value: { k: "group_qa_up", h: a.hash } },
    { tag: "button", text: { tag: "plain_text", content: "👎 没帮助" }, type: "default", value: { k: "group_qa_down", h: a.hash } },
  ];
  if (a.sourceArticleId && a.webBase) {
    actions.push({
      tag: "button",
      text: { tag: "plain_text", content: "查看文档" },
      type: "default",
      url: `${a.webBase.replace(/\/$/, "")}/d/${a.sourceArticleId}`,
    });
  }
  elements.push({ tag: "action", actions });
  return { config: { wide_screen_mode: true }, elements };
}
