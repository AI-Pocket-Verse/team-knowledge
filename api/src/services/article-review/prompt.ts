// 单篇校验 / 一键优化的提示词。校验比每日体检更全面(逻辑/表述/格式/缺失过时/跨文档),
// 但仍要求「只报真正的问题,避免吹毛求疵」。
import type { HashedReviewFinding } from "./findings.js";
import { outputLanguageInstruction } from "../llm/language.js";
import type { Lang } from "../../utils/lang.js";

export const ARTICLE_REVIEW_SYSTEM = `你是团队知识库的「入库前置质检」助手。下面给你【一篇待校验文档】的标题与全文,可能附带【其它相关文档】的摘要做对比。请通读后找出问题,分五类:
- logic 逻辑矛盾:文档内部自相矛盾、步骤错乱、结论与前提冲突;
- clarity 表述不清:歧义、指代不明、关键术语未交代;
- format 格式问题:标题层级混乱、列表/表格残缺、明显排版错误;
- completeness 信息缺失/过时:关键步骤/前置条件缺失、引用了已过时的信息;
- consistency 跨文档出入:与【其它相关文档】对同一事项说法矛盾 / 数据对不上。
只报真正影响阅读或正确性的问题,没有就不报,避免吹毛求疵。每条 problem / suggestion 各 ≤ 60 字。
严格【只输出 JSON】,不要任何解释文字、不要 markdown 代码块,结构:
{"findings":[{"category":"logic|clarity|format|completeness|consistency","severity":"high|med|low","problem":"具体问题","suggestion":"修改建议"}]}
没有任何问题就输出 {"findings":[]}。`;

/** 校验提示词 + 输出语言指令(中文下与原常量完全一致)。 */
export function reviewSystem(lang: Lang): string {
  return ARTICLE_REVIEW_SYSTEM + outputLanguageInstruction(lang);
}

export function buildReviewUserMessage(
  doc: { title: string; body: string },
  related: { title: string; snippet: string }[],
): string {
  const parts: string[] = [];
  // 标题用纯文本标签呈现,【不要】写成 `## 标题` —— 否则它会和正文自带的 `# H1`
  // 形成「H2 在 H1 之前」的假象,模型据此误报标题层级问题(几乎每篇都会中招)。
  parts.push(`【待校验文档】\n标题:${doc.title}\n\n正文:\n${doc.body}`);
  if (related.length > 0) {
    const list = related
      .map((r, i) => `${i + 1}.《${r.title}》:${r.snippet.replace(/\s+/g, " ").slice(0, 500)}`)
      .join("\n");
    parts.push(`\n【其它相关文档】(仅用于判断跨文档一致性,不要去校验它们本身)\n${list}`);
  }
  return parts.join("\n");
}

export const OPTIMIZE_SYSTEM = `你是团队知识库的文档编辑助手。下面给你一篇文档的全文和【已发现的问题清单】,可能附带【其它相关文档】的摘要。请【只针对这些问题做定点修改】,以「查找→替换」补丁的形式给出,【不要重写全文、不要输出整篇文档】。
每条补丁:
- find:从【原文】中【逐字复制】的一小段连续文本 —— 就是要被替换掉的原文片段。必须与原文完全一致(含标点、空格、换行),并包含足够上下文以在全文中【唯一】定位;
- replace:修正后的文本(替换掉 find 的内容)。
要求:
- 只修问题清单里的问题;与问题无关的字句一律不动,不要顺手润色、改写或重排;
- find 尽量短,只覆盖需要改的部分加少量定位上下文,【不要】整段整段地照搬;
- 若问题涉及【跨文档出入】,以【其它相关文档】为准修正本篇(不要去改其它文档);
- 某个问题若无需改动正文、或无法在原文中定位到对应片段,就【不要】为它编造补丁;
- 严格【只输出 JSON】,不要任何解释、不要代码块包裹,结构:
{"edits":[{"find":"原文片段","replace":"修正后片段"}]}
没有需要改动的就输出 {"edits":[]}。`;

export function optimizeSystem(lang: Lang): string {
  return OPTIMIZE_SYSTEM + outputLanguageInstruction(lang);
}

export function buildOptimizeUserMessage(
  doc: { title: string; body: string },
  findings: HashedReviewFinding[],
  related: { title: string; snippet: string }[] = [],
): string {
  const list = findings.map((f, i) => `${i + 1}. [${f.category}] ${f.problem}${f.suggestion ? `(建议:${f.suggestion})` : ""}`).join("\n");
  const parts = [`【文档标题】${doc.title}`, `\n【已发现的问题】\n${list}`];
  // 把复检用过的同角色相关文档摘要也喂给优化器,让 consistency/completeness 类修订不再盲改。
  if (related.length > 0) {
    const rel = related.map((r, i) => `${i + 1}.《${r.title}》:${r.snippet.replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
    parts.push(`\n【其它相关文档】(仅供对齐口径,不要去校验/改写它们本身)\n${rel}`);
  }
  parts.push(`\n【原文】\n${doc.body}`);
  return parts.join("\n");
}

/** 净化一键优化的 LLM 输出:模型有时无视指令,给整篇套上 ```markdown 围栏或加「好的,以下是…」
 *  前言。这些会被原样写入文档(破坏渲染与引用/上传锚定),故落库前剥掉:
 *  仅当【整段】被一对围栏包裹时去掉首尾围栏(不动正文内部合法的代码块)。 */
export function sanitizeOptimizedMarkdown(text: string): string {
  let s = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(s);
  if (fenced) s = fenced[1].trim();
  return s;
}
