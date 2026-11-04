// 把一次运行的产出转成可读 markdown,供「已完成」运行的只读阅读页展示。
// 产出可能是:飞书卡片 JSON(带/不带 msg_type)、```json 代码块、text 消息体、或纯 markdown。
// 命中卡片就把 header 标题 + elements 内容摊平为 markdown;都不像则原样返回。
import { extractJsonObject } from "./webhook.js";

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.content === "string") return o.content;
    if (o.text) return textOf(o.text);
  }
  return "";
}

// 单个卡片元素 → markdown(尽量宽容,覆盖 markdown/div(lark_md)/hr/note/字段组/嵌套 elements)。
function elementToMd(el: unknown): string {
  if (!el || typeof el !== "object") return "";
  const o = el as Record<string, unknown>;
  if (o.tag === "hr") return "\n---";
  if (typeof o.content === "string") return o.content;                 // markdown 元素
  if (o.text) return textOf(o.text);                                   // div + lark_md/plain_text
  if (Array.isArray(o.fields)) return (o.fields as unknown[]).map((f) => textOf((f as Record<string, unknown>)?.text)).filter(Boolean).join("\n");
  if (Array.isArray(o.elements)) return (o.elements as unknown[]).map(elementToMd).filter(Boolean).join("\n"); // note 等容器
  return "";
}

/** 运行产出 → 阅读页 markdown。取不到卡片则原样返回原文。 */
export function renderRunOutput(output: string): string {
  const obj = extractJsonObject(output);
  if (obj) {
    const card = obj.msg_type === "interactive" && obj.card && typeof obj.card === "object"
      ? (obj.card as Record<string, unknown>)
      : (obj.elements || obj.header ? obj : null);
    if (card) {
      const title = textOf((card.header as Record<string, unknown> | undefined)?.title);
      const body = Array.isArray(card.elements)
        ? (card.elements as unknown[]).map(elementToMd).filter((s) => s.trim() !== "").join("\n\n")
        : "";
      const md = (title ? `# ${title}\n\n` : "") + body;
      if (md.trim() !== "") return md;
    }
    // 是 JSON 但不像卡片(如 text 消息体)→ 尝试取 content.text。
    const content = obj.content as Record<string, unknown> | undefined;
    if (content && typeof content.text === "string") return content.text;
  }
  return output;
}
