// 角色 Skill 生成完成后,用「应用机器人」(就是群里能 @ 问答的那个助手)向
// 指定群推一张通知卡片 —— 走 team-knowledge→feishu-sso 的出站网关(feishuGateway.notifyChat
// → feishu-sso /api/feishu/notify → im.message.create,tenant token),与周报/互动
// 通知同一条出站通道,机器人身份统一。
//
// 目标群与开关由管理后台「飞书群通知」配置(notify-config,存 Setting 表;
// FEISHU_SKILL_NOTIFY_CHAT_IDS 仅作未配置时的默认值)。前提:机器人已在目标群里。
//
// fire-and-forget:任何失败只记日志,绝不影响生成流程本身。
import { env } from "../../env.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { applinkWrap, delinkLarkMd } from "../../utils/notify/card.js";
import { targetsIfEnabled } from "../notify-config/index.js";
import { summarizeSkillDiff } from "./skill-diff.js";
import { L, appLang } from "../../utils/lang.js";

/** 角色主页深链(/r/:roleId),含 /team-knowledge base;可选包成飞书 applink。 */
function roleDeepLink(roleId: string): string {
  const base = env.WEB_PUBLIC_URL.replace(/\/$/, "");
  return applinkWrap(`${base}/r/${roleId}`, env.FEISHU_CARD_USE_APPLINK);
}

// 与 generate.ts 的 GenLog 结构兼容(pino 与裸对象都可传)。
interface NotifyLog {
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

/** 组卡片所需(纯展示):变更摘要已算好。changeSummary=null → 首次生成。 */
export interface SkillCardArgs {
  roleId: string;
  roleName: string;
  docCount: number;
  model: string | null;
  generatedAt: Date;
  /** 一句话变更摘要(对比 skill.md 新旧两版);null = 首次生成。 */
  changeSummary: string | null;
}

/** notifySkillUpdated 入参:带新旧 skill.md 内容,由它内部算变更摘要(异步、可注入)。 */
export interface SkillNotifyArgs {
  roleId: string;
  roleName: string;
  docCount: number;
  model: string | null;
  generatedAt: Date;
  /** 上一版 skill.md(空/未传 = 首次生成,不做对比)。 */
  prevContent?: string | null;
  /** 本次 skill.md。 */
  newContent: string;
  log?: NotifyLog;
}

// yyyy-MM-dd HH:mm,北京时间(服务器时区无关)。
export function fmtBeijing(d: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

// 「本次更新」段:首次生成 / 一句话变更摘要(对比 skill.md 新旧两版得出)。
function changesContent(changeSummary: string | null): string {
  const lang = appLang();
  if (!changeSummary) return L(lang, "**本次更新：**首次生成", "**What changed:** First generation");
  return L(lang, `**本次更新**\n${changeSummary}`, `**What changed**\n${changeSummary}`);
}

// 键限定 config/header/elements,通过 feishu-sso 端 validCard 校验。
export function buildSkillUpdatedCard(args: SkillCardArgs): unknown {
  // 文案标点统一全角(:()),与产品文案规范一致。
  const lang = appLang();
  const lines = [
    L(lang, `**角色：**${delinkLarkMd(args.roleName)}`, `**Role:** ${delinkLarkMd(args.roleName)}`),
    L(lang, `**收录文档：**${args.docCount} 篇`, `**Docs included:** ${args.docCount}`),
    args.model ? L(lang, `**生成模型：**${args.model}`, `**Model:** ${args.model}`) : null,
    L(lang, `**生成时间：**${fmtBeijing(args.generatedAt)}`, `**Generated at:** ${fmtBeijing(args.generatedAt)}`),
  ].filter(Boolean);
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: L(lang, "📘 角色 Skill 已更新", "📘 Role skill updated") }, template: "blue" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: changesContent(args.changeSummary) } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: L(lang, "查看角色", "View role") },
            type: "primary",
            url: roleDeepLink(args.roleId),
          },
        ],
      },
    ],
  };
}

export async function notifySkillUpdated(
  args: SkillNotifyArgs,
  send: (chatId: string, card: unknown) => Promise<unknown> = feishuGateway.notifyChat,
  // 变更摘要器(可注入,便于单测不打 LLM)。
  summarize: (prev: string, next: string) => Promise<string | null> = summarizeSkillDiff,
  // 目标群解析器(可注入,便于单测不读 DB):默认读后台配置,任务关闭 → 空数组。
  getTargets: () => Promise<string[]> = () => targetsIfEnabled("skill_updated"),
): Promise<void> {
  try {
    // 目标群解析(读 DB 配置)也在 try 内:这是 fire-and-forget 调用,任何一步
    // 抛出去都会变成 unhandled rejection 把进程带崩。
    const chatIds = await getTargets();
    if (chatIds.length === 0) return;
    // 首次生成(无上一版)→ 不对比;否则对比 skill.md 新旧两版,LLM 失败兜底文案。
    const firstGen = !args.prevContent?.trim();
    const changeSummary = firstGen
      ? null
      : (await summarize(args.prevContent!, args.newContent)) ?? L(appLang(), "本次有更新(变更摘要暂不可用)", "Updated (change summary unavailable)");
    const card = buildSkillUpdatedCard({
      roleId: args.roleId,
      roleName: args.roleName,
      docCount: args.docCount,
      model: args.model,
      generatedAt: args.generatedAt,
      changeSummary,
    });
    // 逐群 best-effort:某个群失败(如机器人不在群)只记日志,不影响其它群。
    await Promise.all(
      chatIds.map((chatId) =>
        Promise.resolve(send(chatId, card)).catch((e) => {
          (args.log?.warn ?? args.log?.error)?.(
            { err: (e as Error).message, roleName: args.roleName, chatId },
            "skill update feishu group notify failed",
          );
        }),
      ),
    );
  } catch (e) {
    // 摘要 / 组卡片阶段出错(与具体群无关)。
    (args.log?.warn ?? args.log?.error)?.(
      { err: (e as Error).message, roleName: args.roleName },
      "skill update feishu group notify failed",
    );
  }
}
