// 群消息「AI 点赞」的两级判定:先廉价规则预筛(挡掉绝大多数,省 LLM),再一次
// LLM 打分(0-10)。评分 rubric 取「知识贡献 ∪ 优质回答」的并集(见方案)。隐私同
// answer.ts:只把消息文本喂 LLM,不检索;点赞记录只存消息前 60 字,不落全文。任何失败一律返回 null(宁可不点)。
import type { FastifyBaseLogger } from "fastify";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import type { GroupMsg } from "./buffer.js";
import { LIKE_EMOJI_OPTIONS } from "./config.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

const LIKE_MIN_CHARS = 15; // 整条消息最短字数(含标点)
const LIKE_MIN_TEXT = 10;  // 去掉 URL/@/表情后仍需的实质文本字数

// 廉价预筛:明显不值得点赞的直接排除,不进 LLM。true = 值得进一步评分。
export function looksLikeLikeCandidate(text: string): boolean {
  const t = text.trim();
  if (t.length < LIKE_MIN_CHARS) return false;
  // 去掉链接 / @提及 / 表情后,仍要有足够实质文本(排除「一句话+一堆表情」这类)。
  const stripped = t
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@\S+/g, "")
    .replace(/[\p{Extended_Pictographic}]/gu, "")
    .trim();
  if (stripped.length < LIKE_MIN_TEXT) return false;
  // 纯寒暄 / 附和 / 情绪(点赞无意义)。
  if (/^(收到|好的?|谢谢|感谢|辛苦了?|ok|okay|嗯+|哈+|赞|可以|不错|👍|666+)+[。.!!~\s]*$/i.test(t)) return false;
  // 机器人指令 / 斜杠命令。
  if (t.startsWith("/")) return false;
  return true;
}

// 各表情适用的「情形」提示,供 smart 模式让 LLM 选最贴切的一个(仅正向白名单)。
const EMOJI_HINT: Record<string, string> = {
  THUMBSUP: "认可 / 说得对 / 普通的好(默认)",
  OK: "确认无误 / 收到并认可",
  DONE: "把问题解决了 / 事情搞定 / 落地完成",
  HEART: "走心 / 暖心 / 值得感谢的贡献",
  APPLAUSE: "很出色 / 干得漂亮 / 重要成果",
  FINGERHEART: "轻松的赞赏 / 比心",
};

const RUBRIC =
  `点赞是稀缺的正反馈,只给真正优质、值得沉淀或对团队有帮助的消息。请综合下述维度,给「待评估消息」打一个 0-10 的整数分:\n` +
  `- 知识贡献:分享经验 / 方案 / 结论 / 踩坑复盘等有沉淀价值的内容;或\n` +
  `- 优质回答:针对他人的问题给出清晰、正确、可落地的解答;\n` +
  `并要求:表述清晰可独立理解、对团队可复用、有实质信息量。\n` +
  `评分档:\n` +
  `- 0-3:寒暄 / 情绪 / 纯附和(收到、好的、哈哈)/ 纯链接或图片无说明 / 闲聊 / 无信息量;\n` +
  `- 4-6:有一点信息但价值一般、零散、仅对个别人有用;\n` +
  `- 7-10:明显有沉淀价值或高质量解答,值得点赞。`;

function buildSystem(pickEmoji: boolean): string {
  const base = `你是工作群里的知识库助手 ${ASSISTANT_NAME},正在给一条群消息的「价值」打分,决定要不要点赞。\n${RUBRIC}\n`;
  if (!pickEmoji) return base + `只输出一个 0-10 的整数,不要任何别的字符。`;
  const list = LIKE_EMOJI_OPTIONS.map((e) => `${e}(${EMOJI_HINT[e] ?? ""})`).join("、");
  return (
    base +
    `\n若打算点赞,再从下列表情里选一个最贴切该消息「情形」的:${list}。拿不准就选 THUMBSUP。\n` +
    `输出格式:一行「分数|表情」,例如 8|DONE。表情必须是上面列出的英文枚举之一。`
  );
}

function buildLikeUser(recent: GroupMsg[], text: string, pickEmoji: boolean): string {
  const convo = recent.slice(-6).map((m) => `${m.senderName}：${m.text}`).join("\n");
  const tail = pickEmoji ? `只输出「分数|表情」一行。` : `只输出 0-10 的整数分。`;
  return `最近对话(仅供理解上下文,不评分):\n${convo || "(无)"}\n\n待评估消息:「${text}」\n\n${tail}`;
}

// 从 LLM 输出里抠出 0-10 的分数;抠不到返回 null。smart 模式输出「分数|表情」,故优先取
// 第一个 `|` 之前那段里的数字(避免模型偶尔在分数前写了「7-10 档」之类把首个数字带偏);
// 无 `|`(fixed 模式只输出一个数字)则退回全串首个数字。
export function parseScore(out: string): number | null {
  const bar = out.indexOf("|");
  const scope = bar >= 0 ? out.slice(0, bar) : out;
  const m = scope.match(/-?\d+/) ?? out.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(10, n));
}

// 从输出里抠出白名单内的表情枚举;没有合法值返回 null(调用方回退兜底表情)。
// 用【词边界】匹配而非子串:否则短枚举(尤其 OK)会误命中普通英文词(LOOKS/BOOK/
// COOK 都含 OK)。白名单值均为 [A-Z_],可安全放进正则。
export function parseEmoji(out: string): string | null {
  const up = out.toUpperCase();
  for (const e of LIKE_EMOJI_OPTIONS) {
    if (new RegExp(`\\b${e}\\b`).test(up)) return e;
  }
  return null;
}

export interface LikeScore {
  score: number;
  emoji: string | null; // smart 模式下 LLM 选的表情;fixed 模式或抠不到时为 null
}

/** LLM 给消息打质量分(0-10),smart 模式下顺带选一个表情;失败 / 繁忙返回 null。
 *  调用前应确保已消费评估预算。 */
export async function scoreMessage(args: {
  recent: GroupMsg[];
  text: string;
  signal: AbortSignal;
  pickEmoji: boolean;
  log?: FastifyBaseLogger;
}): Promise<LikeScore | null> {
  let release: (() => void) | undefined;
  try {
    release = await chatSemaphore.acquire(10_000);
  } catch {
    return null; // AI 繁忙 → 这条不评估
  }
  try {
    const provider = await getProvider();
    const iter = provider.chat(
      { systemPrompt: buildSystem(args.pickEmoji), history: [], userMessage: buildLikeUser(args.recent, args.text, args.pickEmoji) },
      args.signal,
    );
    let full = "";
    for await (const chunk of iter) {
      if (chunk.type === "token") full += chunk.text;
      else if (chunk.type === "error") return null;
    }
    const out = full.trim();
    const score = parseScore(out);
    if (score === null) return null;
    return { score, emoji: args.pickEmoji ? parseEmoji(out) : null };
  } catch {
    return null;
  } finally {
    release?.();
  }
}
