// 群聊智能答疑编排:feishu-sso 把群里「非 @ 的文本消息」转发到这里(setImmediate,fire-and-
// forget)。这里走完整闸门 → 判定作答 → 引用回复。任一步否/异常一律静默返回(群里宁可
// 不发也不发错/发噪)。只响应已启用的知识库成员的发言(非成员 / 已停用成员静默跳过,
// 不进缓冲也不回答)。隐私:作答只 search() 文档库、不传历史与私有上下文(见 answer.ts);
// 落库的只有答疑记录里的问题前 80 字与点赞记录里的消息前 60 字(含发言人姓名),不存全文。
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { getScenarioNotifyConfig, chatLabel } from "../notify-config/index.js";
import { appendMessage, recentMessages, type GroupMsg } from "./buffer.js";
import { looksLikeQuestion, questionHash, cooldownOk, hourlyOk, notAnsweredRecently, markAnswered } from "./gate.js";
import { decideAndAnswer } from "./answer.js";
import { buildGroupAnswerCard } from "./card.js";
import { recordAnswer, isDemoted, alreadyLiked, likeCounters, tryConsumeEvalBudget, recordLike } from "./store.js";
import { getGroupQaTuning, getGroupQaLike } from "./config.js";
import { looksLikeLikeCandidate, scoreMessage } from "./like.js";
import { getGroupCardModel } from "../llm/model-display.js";
import { resolveUserByOpenId } from "../chat/resolveUserByOpenId.js";

export interface ObserveArgs {
  chatId: string;
  messageId: string;
  openId: string;
  senderName: string;
  text: string;
  now: number;
  log?: FastifyBaseLogger;
}

const OBSERVE_TIMEOUT_MS = 40_000; // 判定+作答的硬超时(setImmediate 里跑,不阻塞回调)
const LIKE_TIMEOUT_MS = 20_000;    // 点赞评分的硬超时(比作答短,评分只需一次轻调用)

// 「AI 点赞」支路:与「是否作答」完全独立并行 —— 值得点赞的多是【回答/沉淀】而非问句,
// 故不能挂在 looksLikeQuestion 之后。多层闸门(开关→本群勾选→预筛→去重→限流→评估预算→
// LLM 打分≥阈值)全部通过才点赞。任何一步否/异常一律静默(群里宁可不点也不误点)。
async function evaluateAndLike(a: ObserveArgs): Promise<void> {
  try {
    // 廉价预筛前置(纯文本、无 DB):太短 / 纯表情链接 / 寒暄附和 / 命令直接不评估。
    // 放在配置读取【之前】,让绝大多数普通消息连 DB 都不碰(功能关着时同理)。
    if (!looksLikeLikeCandidate(a.text)) return;
    const like = await getGroupQaLike();
    if (!like.enabled) return;
    // 复用答疑的「本群是否启用」勾选(同一 group_qa 场景配置)。
    const cfg = await getScenarioNotifyConfig("group_qa");
    if (!cfg.enabled || !cfg.chatIds.includes(a.chatId)) return;
    // 「同群同一时刻只评一条」占位锁:check-and-add 同步、其间无 await,故原子。防止
    // 并发多条消息各自读到旧计数、一起通过软上限(群/人每日、冷却)造成小幅超限
    // ——评分要跑几秒,期间同群其它消息直接跳过点赞评估(与作答支路 inFlightChats 同理)。
    if (inFlightLikeChats.has(a.chatId)) return;
    inFlightLikeChats.add(a.chatId);
    try {
      // 去重:该消息已点过赞。
      if (await alreadyLiked(a.messageId)) return;
      // 限流:本群今日上限 / 该人今日被赞上限 / 同群冷却。
      const { groupToday, userToday, lastGroupAt } = await likeCounters(a.chatId, a.openId, a.now);
      if (groupToday >= like.dailyCapPerGroup) { a.log?.info({ chatId: a.chatId, cap: like.dailyCapPerGroup }, "group-qa like skip:本群今日已达点赞上限"); return; }
      if (userToday >= like.userDailyCap) { a.log?.info({ chatId: a.chatId, openId: a.openId, cap: like.userDailyCap }, "group-qa like skip:该成员今日被赞已达上限"); return; }
      if (lastGroupAt !== undefined && a.now - lastGroupAt < like.cooldownMin * 60_000) { a.log?.info({ chatId: a.chatId, cooldownMin: like.cooldownMin }, "group-qa like skip:同群点赞冷却中"); return; }
      // 评估预算(原子消费):没预算就不调 LLM(控成本)。
      if (!(await tryConsumeEvalBudget(a.now, like.evalDailyBudget))) { a.log?.info({ budget: like.evalDailyBudget }, "group-qa like skip:今日评估预算已用尽"); return; }
      // LLM 质量打分(0-10);smart 模式顺带让它选个贴切的表情。上下文排除当前消息本身
      // (它已作为「待评估消息」单独给出,不必在「最近对话」里再列一遍)。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), LIKE_TIMEOUT_MS);
      let scored: Awaited<ReturnType<typeof scoreMessage>>;
      try {
        scored = await scoreMessage({ recent: recentMessages(a.chatId).filter((m) => m.messageId !== a.messageId), text: a.text, signal: ac.signal, pickEmoji: like.emojiMode === "smart", log: a.log });
      } finally {
        clearTimeout(timer);
      }
      if (scored === null) return; // 评分失败 / 繁忙 —— 静默
      if (scored.score < like.threshold) { a.log?.info({ chatId: a.chatId, score: scored.score, threshold: like.threshold }, "group-qa like skip:分数未达阈值"); return; }
      // smart 模式用 LLM 选的表情,拿不准 / fixed 模式回退到配置的兜底表情。
      const emoji = like.emojiMode === "smart" && scored.emoji ? scored.emoji : like.emoji;
      await feishuGateway.react(a.messageId, emoji);
      await recordLike({
        messageId: a.messageId, chatId: a.chatId, chatName: chatLabel(a.chatId),
        openId: a.openId, senderName: a.senderName, score: scored.score,
        // 按码点截断,避免把 4 字节 emoji 从中间切成半个代理对(看板显示成 �)。
        emoji, preview: [...a.text].slice(0, 60).join(""), at: a.now,
      });
      a.log?.info({ event: "group_qa.liked", chatId: a.chatId, score: scored.score, emoji }, "group-qa liked");
    } finally {
      inFlightLikeChats.delete(a.chatId);
    }
  } catch (e) {
    a.log?.warn?.({ err: (e as Error).message, chatId: a.chatId }, "group-qa like failed (silent)");
  }
}

// 同一群「正在处理中」的标记。每条群消息各自 setImmediate 进来,闸门检查(冷却/去重)
// 在慢的 LLM 调用之前、markAnswered 在之后 —— 若不锁,并发到来的同群消息会都通过闸门、
// 都回复(双发 TOCTOU)。这里同步「检查并占位」,同群同一时刻只处理一条(其余直接跳过,
// 冷却本也会挡)。占位的 add 与前面的同步闸门检查之间无 await,保证原子。
const inFlightChats = new Set<string>();
// 同上,给「AI 点赞」支路的同群占位锁(见 evaluateAndLike):防并发多条一起冲破软限流。
const inFlightLikeChats = new Set<string>();

export async function observeGroupMessage(a: ObserveArgs): Promise<void> {
  // 只服务已启用的成员:群里的外部伙伴 / 已停用账号发言,既不触发回答也不进上下文缓冲。
  // 查询失败同样静默跳过(群里宁可不答)。
  try {
    if (!(await resolveUserByOpenId(a.openId))) return;
  } catch (e) {
    a.log?.warn?.({ err: (e as Error).message, chatId: a.chatId }, "group-qa 成员校验失败(静默跳过)");
    return;
  }
  // 任何消息都先进缓冲(供后续「最近几条」上下文),即使本群没开答疑 / 不是问题。
  const msg: GroupMsg = { messageId: a.messageId, openId: a.openId, senderName: a.senderName, text: a.text, ts: a.now };
  appendMessage(a.chatId, msg);
  // 「AI 点赞」与「作答」并行、互不影响:好消息常是回答/沉淀而非问句,故不能挂在下面
  // 的问句预筛之后。fire-and-forget(自带 try/catch,不会有未捕获拒绝)。
  void evaluateAndLike(a);
  // 廉价预筛前置:非问句直接返回,连配置(DB 读)都省了。
  if (!looksLikeQuestion(a.text)) return;
  // 以下「跳过原因」日志只在消息像问题时才打(低量),便于排查「发了问题却没回复」:
  // 未启用 / 本群未勾选 / 已降权 / 冷却限频 / LLM 判定不答,各有迹可循。
  try {
    const cfg = await getScenarioNotifyConfig("group_qa");
    if (!cfg.enabled) { a.log?.info({ chatId: a.chatId }, "group-qa skip:未启用"); return; }
    if (!cfg.chatIds.includes(a.chatId)) { a.log?.info({ chatId: a.chatId, selected: cfg.chatIds }, "group-qa skip:本群未勾选"); return; }
    // 互动节奏参数(冷却/每小时上限/去重/降权/答案长度)后台可配,越界已在 config 层夹紧。
    // 必须在下面同步闸门区之前 await 取好(闸门区内不能有 await,否则破坏 inFlightChats 原子占位)。
    const tuning = await getGroupQaTuning();
    const hash = questionHash(a.text);
    if (await isDemoted(hash, a.now, tuning.demoteDays * 86_400_000)) { a.log?.info({ chatId: a.chatId }, "group-qa skip:已反对降权"); return; }
    // ── 以下到 inFlightChats.add 之间必须保持同步(无 await),才能原子占位 ──
    if (inFlightChats.has(a.chatId)) { a.log?.info({ chatId: a.chatId }, "group-qa skip:同群处理中"); return; }
    // ↓ 三种「反刷屏」原因分开打日志,便于排查「明明发了却没回复」(都不带 await,维持上面占位的原子性):
    if (!cooldownOk(a.chatId, a.now, tuning.cooldownSec * 1000)) { a.log?.info({ chatId: a.chatId, cooldownSec: tuning.cooldownSec }, "group-qa skip:同群冷却中(距上次回答未满冷却间隔)"); return; }
    if (!hourlyOk(a.chatId, a.now, tuning.hourlyCap)) { a.log?.info({ chatId: a.chatId, hourlyCap: tuning.hourlyCap }, "group-qa skip:同群每小时已达上限"); return; }
    if (!notAnsweredRecently(hash, a.now, tuning.dedupMin * 60_000)) { a.log?.info({ chatId: a.chatId, hash, dedupMin: tuning.dedupMin }, "group-qa skip:同问题去重窗口内已答过(@他人或换人复述同一问题也算同问题,故第二次不再答)"); return; }
    inFlightChats.add(a.chatId);
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), OBSERVE_TIMEOUT_MS);
      let result;
      try {
        result = await decideAndAnswer({ recent: recentMessages(a.chatId), question: a.text, signal: ac.signal, answerCap: tuning.answerCap, aggressiveness: tuning.aggressiveness, log: a.log });
      } finally {
        clearTimeout(timer);
      }
      if (!result) return; // 具体原因(检索 0 命中 / LLM 判定不答)已在 decideAndAnswer 内分别打日志

      const card = buildGroupAnswerCard({
        quote: a.text,
        senderName: a.senderName,
        answer: result.answer,
        sourceTitle: result.sourceTitle,
        sourceArticleId: result.sourceArticleId,
        hash,
        webBase: env.WEB_PUBLIC_URL,
        model: await getGroupCardModel(), // 后台开关关 → undefined(卡片不显示模型)
      });
      await feishuGateway.replyInChat(a.messageId, card); // 引用原消息回复
      markAnswered(a.chatId, hash, a.now); // 置冷却 + 计入每小时 + 记问题指纹
      await recordAnswer({ chatId: a.chatId, chatName: chatLabel(a.chatId), question: a.text.slice(0, 80), sourceTitle: result.sourceTitle ?? "", hash, at: a.now });
      a.log?.info({ event: "group_qa.answered", chatId: a.chatId, source: result.sourceTitle }, "group-qa answered");
    } finally {
      inFlightChats.delete(a.chatId);
    }
  } catch (e) {
    a.log?.warn?.({ err: (e as Error).message, chatId: a.chatId }, "group-qa observe failed (silent)");
  }
}
