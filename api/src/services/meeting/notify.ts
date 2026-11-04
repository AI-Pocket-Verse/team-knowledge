// 会议纪要生成完成后,用「应用机器人」向群推一张通知卡片:会议标题 + 纪要正文
// (摘选)+ 跳转会议页按钮。与 Skill/周报 同一条出站通道(feishuGateway.notifyChat
// → feishu-sso /api/feishu/notify)。
//
// 目标群与开关由管理后台「飞书群通知」配置(notify-config,存 Setting 表;
// FEISHU_MEETING_NOTIFY_CHAT_IDS 仅作未配置时的默认值)。
// fire-and-forget:任何失败只记日志,绝不影响纪要生成本身。
import { env } from "../../env.js";
import { prisma } from "../../db.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { applinkWrap, delinkLarkMd } from "../../utils/notify/card.js";
import { targetsIfEnabled } from "../notify-config/index.js";
import { fmtBeijing } from "../role-skill/notify.js";

/** 纪要群通知的一次性认领(CAS:仅当 minutesNotifiedAt 仍为 null 时置位)。
 *  返回 true = 本次调用抢到通知权;手动「重新生成」与并发生成都只会有一次 true,
 *  从根上杜绝同一场会议反复向群播报。 */
export async function claimMinutesNotified(sessionId: string): Promise<boolean> {
  const r = await prisma.meetingSession.updateMany({
    where: { id: sessionId, minutesNotifiedAt: null },
    data: { minutesNotifiedAt: new Date() },
  });
  return r.count === 1;
}

interface NotifyLog {
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

const PREVIEW_CAP = 1200; // 卡片里纪要正文最多展示多少字符,超出截断并提示见链接

/** 会议详情页深链(/meeting/:id),含 /team-knowledge base;可选包成飞书 applink。 */
function meetingDeepLink(meetingId: string): string {
  const base = env.WEB_PUBLIC_URL.replace(/\/$/, "");
  return applinkWrap(`${base}/meeting/${meetingId}`, env.FEISHU_CARD_USE_APPLINK);
}

/** 把纪要 markdown 转成飞书 lark_md 友好的预览:## 标题 → 加粗,并按上限截断。 */
export function minutesToLarkMd(md: string): string {
  const converted = md
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+(.*)$/, "**$1**")) // ## 决策点 → **决策点**
    .join("\n")
    .trim();
  if (converted.length <= PREVIEW_CAP) return converted;
  return converted.slice(0, PREVIEW_CAP).trimEnd() + "\n…(纪要较长,点下方按钮查看完整内容)";
}

export interface MeetingMinutesCardArgs {
  meetingId: string;
  title: string;
  summaryMarkdown: string;
  /** 纪要生成时间;用于卡片落款。 */
  generatedAt: Date;
}

// 键限定 config/header/elements,通过 feishu-sso 端 validCard 校验。
export function buildMeetingMinutesCard(args: MeetingMinutesCardArgs): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "📝 会议纪要已生成" }, template: "blue" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**会议:**${delinkLarkMd(args.title)}\n**生成时间:**${fmtBeijing(args.generatedAt)}` } },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: minutesToLarkMd(args.summaryMarkdown) } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看会议纪要" },
            type: "primary",
            url: meetingDeepLink(args.meetingId),
          },
        ],
      },
    ],
  };
}

export interface MeetingNotifyArgs {
  meetingId: string;
  title: string;
  summaryMarkdown: string;
  generatedAt: Date;
  /** 会议可见性。私密会议只有创建者能看，纪要不外发到群（必填，调用方不能漏传）。 */
  visibility: string;
  /** 一次性认领(CAS,见 claimMinutesNotified)。在确认「开关开着且有目标群」
   *  之后才执行 —— 开关关着时不消耗认领,之后管理员开启再「重新生成纪要」
   *  仍能播报;先烧认领的话这场会议就永远静默了。返回 false = 已播报过,跳过。 */
  claim?: () => Promise<boolean>;
  log?: NotifyLog;
}

export async function notifyMeetingMinutes(
  args: MeetingNotifyArgs,
  send: (chatId: string, card: unknown) => Promise<unknown> = feishuGateway.notifyChat,
  // 目标群解析器(可注入,便于单测不读 DB):默认读后台配置,任务关闭 → 空数组。
  getTargets: () => Promise<string[]> = () => targetsIfEnabled("meeting_minutes"),
): Promise<void> {
  if (args.visibility !== "public") return; // 私密会议：不外发，也不消耗认领
  const chatIds = await getTargets();
  if (chatIds.length === 0) return;
  if (args.claim && !(await args.claim())) return; // 这场会议已经播报过
  const card = buildMeetingMinutesCard({
    meetingId: args.meetingId,
    title: args.title,
    summaryMarkdown: args.summaryMarkdown,
    generatedAt: args.generatedAt,
  });
  // 逐群 best-effort:某群失败(如机器人不在群)只记日志,不影响其它群。
  await Promise.all(
    chatIds.map((chatId) =>
      Promise.resolve(send(chatId, card)).catch((e) => {
        (args.log?.warn ?? args.log?.error)?.(
          { err: (e as Error).message, meetingId: args.meetingId, chatId },
          "meeting minutes feishu group notify failed",
        );
      }),
    ),
  );
}
