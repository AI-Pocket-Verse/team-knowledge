// 三期:后台任务经助手生成内容并通知飞书用户。给定「意图 + 上下文」,让
//助手写一段拟人文案,经飞书机器人推给该用户(出站走 feishuGateway.notify,
// 与周报/新用户提醒同一条通道)。conversational=true 时把这段话作为 assistant
// 记录追加到该用户的共享会话 —— 用户在飞书直接回复即可顺一期 1:1 链路继续多轮。
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { applinkWrap } from "../../utils/notify/card.js";
import { getProvider } from "../llm/registry.js";
import { notifyAuthorSemaphore, runExclusive } from "../../utils/concurrency.js";
import { getOrCreateFeishuConversation } from "../chat/conversations.js";
import { publishChatUpdate } from "../chat/chat-events.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

export interface NotifyViaAssistantArgs {
  userId: string;
  /** 这条通知关于什么 —— 给助手的指令(也是降级时的兜底文案)。 */
  intent: string;
  /** 附加数据 / 上下文(可选)。 */
  context?: string;
  /** true → 追加到该用户共享会话,可在飞书继续对话;false(默认)→ 纯推送。 */
  conversational?: boolean;
  /** 可选跳转按钮(如「查看周报」)。 */
  link?: { text: string; url: string };
  log?: FastifyBaseLogger;
}

const NOTIFY_SYSTEM_PROMPT =
  `你是 ${ASSISTANT_NAME},团队知识库助手。把给定的「通知意图」和「上下文」改写成一条简短、` +
  "自然、友好的中文通知,直接面向用户本人。不超过 2 句话,不要寒暄客套、不要加" +
  "标题或 markdown 语法,只输出通知正文本身。";

// 一次性 LLM 补全:intent/context → 一段通知文案。繁忙/超时/出错都降级为 intent
// 文本(背景通知不应因 LLM 抖动而丢失)。
async function authorNotification(
  intent: string,
  context: string | undefined,
  log?: FastifyBaseLogger,
): Promise<string> {
  let release: () => void;
  try {
    release = await notifyAuthorSemaphore.acquire(15_000);
  } catch {
    return intent; // 繁忙降级:直接用意图文本
  }
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), 60_000);
  let out = "";
  try {
    const provider = await getProvider();
    const userMessage = `[通知意图]\n${intent}${context ? `\n\n[上下文]\n${context}` : ""}`;
    for await (const chunk of provider.chat({ systemPrompt: NOTIFY_SYSTEM_PROMPT, history: [], userMessage }, ac.signal)) {
      if (chunk.type === "token") out += chunk.text;
      else if (chunk.type === "error") {
        log?.error?.({ message: chunk.message }, "assistant notify authoring failed");
        break;
      }
    }
  } catch (e) {
    // getProvider() or the provider iterator can THROW (spawn failure, abort,
    // rate-limit-surfaced-as-throw). Degrade to the intent text — a background
    // notice must never bubble an error to its caller (best-effort contract).
    log?.error?.({ err: (e as Error).message }, "assistant notify authoring threw");
    return intent;
  } finally {
    clearTimeout(guard);
    release();
  }
  return out.trim().slice(0, 800) || intent;
}

// 通知卡片:文案走 plain_text(防注入,与 adminAlert 同),可选跳转按钮。键限定
// config/header/elements 以通过 feishu-sso 端 validCard 校验。
function buildAssistantNotifyCard(text: string, link?: { text: string; url: string }): unknown {
  const elements: unknown[] = [{ tag: "div", text: { tag: "plain_text", content: text } }];
  if (link) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: link.text },
          type: "primary",
          url: applinkWrap(link.url, env.FEISHU_CARD_USE_APPLINK),
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: `${ASSISTANT_NAME} 提醒` } },
    elements,
  };
}

/**
 * 后台 →助手生成 → 通知飞书用户。返回是否发出 + 未发原因。best-effort:任何
 * 一步失败都不抛(调用方多为后台任务,不应被它中断)。
 */
export async function notifyUserViaAssistant(args: NotifyViaAssistantArgs): Promise<{ sent: boolean; reason?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { id: true, ssoId: true, isActive: true },
  });
  if (!user || !user.isActive) return { sent: false, reason: "inactive_or_missing" };
  // 出站只能按飞书 open_id(ou_*)投递 —— 非飞书身份无处可推。
  if (!user.ssoId || !user.ssoId.startsWith("ou_")) return { sent: false, reason: "no_feishu_open_id" };

  const text = await authorNotification(args.intent, args.context, args.log);
  const card = buildAssistantNotifyCard(text, args.link);
  try {
    await feishuGateway.notify(user.ssoId, card);
  } catch (e) {
    args.log?.error?.({ err: (e as Error).message, userId: user.id }, "assistant notify push failed");
    return { sent: false, reason: "push_failed" };
  }

  // 可对话:把这条话作为 assistant 记录追加到用户共享会话,用户在飞书回复即可
  // 顺一期 1:1 链路继续(下一轮 runChatTurn 会把它读进历史)。纯推送则不落库。
  if (args.conversational) {
    const conv = await getOrCreateFeishuConversation(user.id);
    // Serialize on the shared per-conversation lock so this notice can't wedge
    // between a live turn's user message and its assistant reply.
    await runExclusive(conv.id, () =>
      prisma.chatMessage.create({ data: { conversationId: conv.id, role: "assistant", content: text, source: "notify" } }),
    )
      .then(() => publishChatUpdate(user.id, { source: "notify" }))
      .catch((e) => args.log?.error?.({ err: (e as Error).message }, "assistant notify persist failed"));
  }
  return { sent: true };
}
