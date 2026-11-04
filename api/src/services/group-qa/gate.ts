// 群聊智能答疑的「闸门」:决定要不要为某条消息触发一次答疑判定。纯启发式 + 内存计数,
// 用于在调 LLM 之前廉价过滤(省钱省噪),以及答疑后的限频/去重/反对降权。时间一律由
// 调用方传入(便于单测);进程内状态,重启即清空(可接受)。

import { createHash } from "node:crypto";

// 「值得让 LLM 判一判」的启发式:命中问号 / 疑问词 / 表示疑问的陈述 / 求助 / 报错 / 索取资料 /
// 求证语气等才进下一步(检索 + LLM 判定)。中等积极度:不光抓带「?」的问句,也抓「疑问陈述句 /
// 不明确的问题 / 正在讨论的问题 / 索取文档 / 求证推测」(这些常无问号)。
//
// 设计:这里只收敛**意图语气词**(问 / 求助 / 索取 / 求证)这一有限闭集 —— 开放集的「话题词」
// (会员协议 / SDK / sql 等)不在这里枚举,交给 search() 判相关性、交给 LLM 判该不该答。所以
// 这层放宽不是打地鼠:补全意图标记即可,具体答不答仍由后续检索 + LLM 把关,挡掉纯闲聊/应答。
const QUESTION_HINTS = [
  // 疑问词
  "吗", "呢", "怎么", "怎样", "如何", "为什么", "为啥", "为何", "咋", "怎么办", "怎么回事",
  "能不能", "能否", "可不可以", "可否", "是不是", "是否", "有没有", "有无", "到底",
  "请问", "求助", "求问", "求教", "请教", "什么意思", "啥意思", "多少", "哪个", "哪些", "哪里", "在哪",
  // 表示疑问 / 不确定的陈述句(「不明确的问题」,通常没问号)
  "不知道", "不清楚", "不太清楚", "搞不清", "弄不清", "没搞清", "不明白", "没明白", "不懂", "没懂",
  "没搞懂", "搞不懂", "不确定", "不太确定", "不晓得", "看不懂", "没看懂", "不会弄", "不会用", "求解",
  // 求助 / 找人
  "帮忙", "帮我", "帮看", "谁知道", "有人知道", "有谁", "想问", "想请教", "麻烦问", "在线等", "求大佬",
  // 报错 / 问题(「正在讨论的问题」)
  "报错", "出错", "进不去", "打不开", "用不了", "加载不", "显示不", "失败", "没反应", "卡住", "异常", "无法",
  // 索取 / 请求资料(祈使句,常无问号):「会员协议发我一下」「给我份接入文档」「sql 脚本谁有」
  "发我", "发个", "发一下", "发下", "发来", "发份", "发出来", "给我", "给个", "给份", "来一份", "来份", "来个",
  "找一下", "找找", "谁有", "哪有", "分享一下", "分享下", "共享", "同步一下", "求个", "求份", "求一份", "想要", "要一份", "要份",
  // 求证 / 推测(陈述句带语气词,寻求确认):「sql脚本应该包含全部建表语句吧」「是吧 / 对吧」
  "吧", "对吧", "是吧", "对不对", "难道", "莫非", "应该",
];

/** 这条消息是否「值得判一判」。空文本/纯闲聊 → false(不触发,省 LLM)。带问号或上面任一
 *  关键词(含「表示疑问的陈述句」)即放行,真正该不该答由后续 LLM 判定。 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  return QUESTION_HINTS.some((h) => t.includes(h));
}

/** 问题归一化指纹:去空白/标点 + 小写 → 12 位。用于「同问题短时间不重复答」与反对降权。 */
export function questionHash(text: string): string {
  const norm = text.replace(/\s+/g, "").replace(/[，。！？、,.!?；;：:~～·…\-—()（）"'“”'']/g, "").toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

// ── 限频 / 去重(内存计数,now 由调用方注入)──
const lastAnswerAt = new Map<string, number>(); // chatId → 上次主动回答时刻
const hourlyHits = new Map<string, number[]>(); // chatId → 最近一小时回答时刻
const answeredAt = new Map<string, number>(); // questionHash → 上次回答时刻

const COOLDOWN_MS = 45_000; // 同群两次主动回答最短间隔
const HOURLY_CAP = 6; // 每群每小时主动回答上限
const HOUR_MS = 3_600_000;
const ANSWERED_TTL_MS = 1_800_000; // 同一问题 30 分钟内不重复答

/** 同群冷却已过?(从未答过 → 直接放行,不受 now 绝对值影响) */
export function cooldownOk(chatId: string, now: number, gapMs = COOLDOWN_MS): boolean {
  const last = lastAnswerAt.get(chatId);
  return last === undefined || now - last >= gapMs;
}

/** 同群每小时上限未到?(顺带清理过期窗口) */
export function hourlyOk(chatId: string, now: number, cap = HOURLY_CAP, windowMs = HOUR_MS): boolean {
  const arr = (hourlyHits.get(chatId) ?? []).filter((t) => now - t < windowMs);
  hourlyHits.set(chatId, arr);
  return arr.length < cap;
}

/** 同一问题最近没答过? */
export function notAnsweredRecently(hash: string, now: number, ttlMs = ANSWERED_TTL_MS): boolean {
  const t = answeredAt.get(hash);
  return t === undefined || now - t >= ttlMs;
}

/** 成功回答后统一记账:置冷却 + 计入每小时窗口 + 记问题指纹。 */
export function markAnswered(chatId: string, hash: string, now: number): void {
  lastAnswerAt.set(chatId, now);
  const arr = (hourlyHits.get(chatId) ?? []).filter((t) => now - t < HOUR_MS);
  arr.push(now);
  hourlyHits.set(chatId, arr);
  answeredAt.set(hash, now);
}

/** 测试用:清空所有计数。 */
export function _resetGate(): void {
  lastAnswerAt.clear();
  hourlyHits.clear();
  answeredAt.clear();
}
