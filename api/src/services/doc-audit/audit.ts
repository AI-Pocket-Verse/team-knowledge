// 知识库「文档体检」互动卡片(纯函数)—— 飞书卡片 2.0 + 原生勾选器(checker)清单。
// 每条问题一行:复选框 + 文本,点一下即时打勾 + 删除线(客户端本地秒回);勾选回传
// doc_audit_ack(可来回切换:勾=确认/下次不提醒,取消=撤销)。顶层只用 schema/config/
// header/body 以过 feishu-sso 端 validCard(2.0)校验。删除线靠 checked_style,非 markdown ~~。
import { fmtBeijing } from "../role-skill/notify.js";
import { AUDIT_CATEGORIES, CATEGORY_LABEL, CATEGORY_LABEL_EN, type HashedFinding } from "./findings.js";
import { L, appLang } from "../../utils/lang.js";

const MAX_CHECKERS = 50; // 每张卡最多带勾选框的条目数(其余仅文字,避免卡片过大)

export interface DocAuditCardArgs {
  findings: HashedFinding[];
  /** 这张卡里已确认(勾上、划线)的 hash。 */
  acknowledgedHashes: Set<string>;
  docCount: number;
  /** 仍因超长被截断的篇数(分批后通常 0)。 */
  truncated: number;
  generatedAt: Date;
  /** true = 所有批次都失败 → 走「未生成结果」兜底。 */
  llmFailed: boolean;
}

type Elem = Record<string, unknown>;

/** 卡片 2.0 的富文本块。div+lark_md 是 1.0 写法,在 2.0 会报错,统一用 markdown。 */
const md = (content: string): Elem => ({ tag: "markdown", content });

function metaContent(args: DocAuditCardArgs): string {
  const lang = appLang();
  if (lang === "en") {
    return (
      `**Docs checked**: ${args.docCount}` +
      (args.truncated > 0 ? `, ${args.truncated} too long (only the beginning was checked)` : "") +
      `\n**Checked at**: ${fmtBeijing(args.generatedAt)}`
    );
  }
  return (
    // 冒号放在 **加粗** 外面:闭合 ** 若紧跟「标点+非空白」(如 `:**26`)会触发 CommonMark
    // flanking 规则不闭合 → ** 显示成字面量;`**词**：值` 闭合 ** 紧跟 CJK 才能正常加粗。全角冒号/逗号。
    `**检查文档**：${args.docCount} 篇` +
    (args.truncated > 0 ? `，其中 ${args.truncated} 篇超长仅检查了开头` : "") +
    `\n**检查时间**：${fmtBeijing(args.generatedAt)}`
  );
}

/** 单条 finding → 一个勾选器。checked 反映当前 ack 态;不设 disabled(保持可来回切换)。 */
function checkerOf(f: HashedFinding, label: string, checked: boolean): Elem {
  return {
    tag: "checker",
    name: `ack_${f.hash}`,
    checked,
    text: { tag: "lark_md", content: label },
    checked_style: { show_strikethrough: true, opacity: 0.5 },
    behaviors: [{ type: "callback", value: { k: "doc_audit_ack", h: f.hash } }],
  };
}

function bodyElements(args: DocAuditCardArgs): Elem[] {
  const lang = appLang();
  if (args.docCount === 0) return [md(L(lang, "知识库暂无已发布文档,跳过本次体检。", "No published docs in the knowledge base. Skipping this check."))];
  if (args.llmFailed) return [md(L(lang, "本次体检未生成结果(模型繁忙或超时),下一个工作日会再次自动检查。", "No result this time (model busy or timed out). It will run again on the next working day."))];
  if (args.findings.length === 0) return [md(L(lang, "本次体检未发现明显问题。", "No obvious issues found in this check."))];

  const els: Elem[] = [];
  let checkersLeft = MAX_CHECKERS;
  let omitted = 0;
  for (const cat of AUDIT_CATEGORIES) {
    const items = args.findings.filter((f) => f.category === cat);
    els.push(md(`**${(lang === "en" ? CATEGORY_LABEL_EN : CATEGORY_LABEL)[cat]}**`));
    if (items.length === 0) {
      els.push(md(L(lang, "未发现", "None found")));
      continue;
    }
    items.forEach((f, i) => {
      const doc = f.docTitle ? L(lang, `《${f.docTitle}》`, `"${f.docTitle}" `) : "";
      const sug = f.suggestion ? L(lang, `（建议：${f.suggestion}）`, ` (Suggestion: ${f.suggestion})`) : "";
      const line = `${i + 1}. ${doc}${f.problem}${sug}`;
      if (checkersLeft > 0) {
        checkersLeft -= 1;
        els.push(checkerOf(f, line, args.acknowledgedHashes.has(f.hash)));
      } else {
        omitted += 1;
        els.push(md(line));
      }
    });
  }
  if (omitted > 0) els.push(md(L(lang, `<font color='grey'>另有 ${omitted} 条未配勾选框（单卡上限 ${MAX_CHECKERS}）</font>`, `<font color='grey'>${omitted} more without checkboxes (max ${MAX_CHECKERS} per card)</font>`)));
  return els;
}

export function buildDocAuditCard(args: DocAuditCardArgs): unknown {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: { title: { tag: "plain_text", content: L(appLang(), "📋 知识库文档体检", "📋 Knowledge base check") }, template: "blue" },
    body: {
      elements: [
        md(metaContent(args)),
        { tag: "hr" },
        ...bodyElements(args),
      ],
    },
  };
}
