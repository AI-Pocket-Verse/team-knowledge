// 群聊智能答疑的持久化(Setting JSON,免迁移,同 doc-audit acks 思路):
//   group.qa.stats    最近答疑记录(看板用,含👎数),cap 500
//   group.qa.demoted  被「👎 没帮助」过的问题指纹 → 时刻(反对降权:TTL 内同问题不再答)
// Setting 读-改-写非原子,群里多人点👎/并发答疑会丢更新 → 进程内串行锁串起所有写
// (team-knowledge 单进程,足够;若将来多实例横向扩展,需改成 prisma.$transaction 行级串行)。
import { getSetting, setSetting } from "../settings.js";

const STATS_KEY = "group.qa.stats";
const DEMOTED_KEY = "group.qa.demoted";
const STATS_CAP = 500;
const DEMOTED_CAP = 500;
const DEMOTE_TTL_MS = 7 * 24 * 3_600_000; // 反对降权「读判定」默认窗口 7 天(未传配置时的兜底)
// 存储 GC 窗口:清理旧降权记录只是为了控容量,不应决定「多久算降权」——那由 isDemoted 的
// (可配)ttl 决定。GC 必须放宽到「最大可配降权天数」(见 config.ts DEMOTE_DAYS_MAX=90),
// 否则管理员把降权设成 >7 天时,超 7 天的记录会被这里提前删掉,延长静默失效。
const DEMOTE_GC_MS = 90 * 24 * 3_600_000;

export interface QaStatEntry {
  chatId: string;
  chatName: string;
  question: string;
  sourceTitle: string;
  hash: string;
  at: number;
  upvotes: number;
  downvotes: number;
}

let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 记一条已回答(看板用)。 */
export async function recordAnswer(e: Omit<QaStatEntry, "upvotes" | "downvotes">): Promise<void> {
  await withLock(async () => {
    const list = await getSetting<QaStatEntry[]>(STATS_KEY, []);
    list.push({ ...e, upvotes: 0, downvotes: 0 });
    if (list.length > STATS_CAP) list.splice(0, list.length - STATS_CAP);
    await setSetting(STATS_KEY, list, "system:group-qa");
  });
}

/** 「👍 有帮助」:给统计里最近匹配 hash 的条目 +1(不影响降权)。 */
export async function registerUpvote(hash: string, _now: number): Promise<void> {
  await withLock(async () => {
    const list = await getSetting<QaStatEntry[]>(STATS_KEY, []);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].hash === hash) { list[i].upvotes += 1; break; }
    }
    await setSetting(STATS_KEY, list, "system:group-qa");
  });
}

/** 最近 limit 条答疑(新 → 旧)。 */
export async function recentStats(limit = 100): Promise<QaStatEntry[]> {
  const list = await getSetting<QaStatEntry[]>(STATS_KEY, []);
  return list.slice(-limit).reverse();
}

/** 「👎 没帮助」:把该问题指纹记入降权集(下次同问题不再答)+ 给统计里最近匹配条 +1。 */
export async function registerDownvote(hash: string, now: number): Promise<void> {
  await withLock(async () => {
    const demoted = await getSetting<Record<string, number>>(DEMOTED_KEY, {});
    demoted[hash] = now;
    for (const [h, t] of Object.entries(demoted)) if (now - t > DEMOTE_GC_MS) delete demoted[h];
    const keys = Object.keys(demoted);
    if (keys.length > DEMOTED_CAP) {
      const oldest = keys.sort((a, b) => demoted[a] - demoted[b]).slice(0, keys.length - DEMOTED_CAP);
      for (const h of oldest) delete demoted[h];
    }
    await setSetting(DEMOTED_KEY, demoted, "system:group-qa");

    const list = await getSetting<QaStatEntry[]>(STATS_KEY, []);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].hash === hash) { list[i].downvotes += 1; break; }
    }
    await setSetting(STATS_KEY, list, "system:group-qa");
  });
}

/** 该问题是否已被反对(降权,TTL 内)。 */
export async function isDemoted(hash: string, now: number, ttlMs = DEMOTE_TTL_MS): Promise<boolean> {
  const demoted = await getSetting<Record<string, number>>(DEMOTED_KEY, {});
  const t = demoted[hash];
  return t !== undefined && now - t < ttlMs;
}

// ─── 群消息「AI 点赞」持久化(Setting JSON,同上思路)────────────────────────
//   group.qa.likes            最近点赞记录(去重 + 限流计数 + 看板),cap 1000
//   group.qa.like.eval_daily  每天(北京日历日)LLM 评估次数桶 {yyyy-mm-dd: n},控成本
// 隐私:只存消息前 60 字(preview)与元信息(群名、发言人姓名与 openId),不落全文。
const LIKES_KEY = "group.qa.likes";
const LIKES_CAP = 1000;
const EVAL_DAILY_KEY = "group.qa.like.eval_daily";
const EVAL_DAILY_KEEP = 14; // 只保留最近 14 天的评估计数桶

export interface LikeEntry {
  messageId: string;
  chatId: string;
  chatName: string;
  openId: string;      // 被点赞消息的发送者(用于「每人每日上限」)
  senderName: string;
  score: number;       // LLM 质量分(0-10)
  emoji: string;       // 实际点的表情(smart 模式可能各条不同)
  preview: string;     // 消息前 60 字;不落全文
  at: number;
}

// 北京日历日 yyyy-mm-dd(UTC+8,无夏令时)。用于「每天」口径的计数。
function beijingDay(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 该消息是否已点过赞(按 messageId 去重,避免重复点)。 */
export async function alreadyLiked(messageId: string): Promise<boolean> {
  const list = await getSetting<LikeEntry[]>(LIKES_KEY, []);
  return list.some((e) => e.messageId === messageId);
}

/** 记一条点赞(去重 / 限流计数 / 看板共用)。 */
export async function recordLike(e: LikeEntry): Promise<void> {
  await withLock(async () => {
    const list = await getSetting<LikeEntry[]>(LIKES_KEY, []);
    list.push(e);
    if (list.length > LIKES_CAP) list.splice(0, list.length - LIKES_CAP);
    await setSetting(LIKES_KEY, list, "system:group-qa");
  });
}

/** 最近 limit 条点赞(新 → 旧,看板用)。 */
export async function recentLikes(limit = 100): Promise<LikeEntry[]> {
  const list = await getSetting<LikeEntry[]>(LIKES_KEY, []);
  return list.slice(-limit).reverse();
}

/** 限流计数:今日(北京日历日)该群 / 该人被点赞次数、该群最近一次点赞时刻(冷却用)。 */
export async function likeCounters(chatId: string, openId: string, now: number): Promise<{
  groupToday: number;
  userToday: number;
  lastGroupAt: number | undefined;
}> {
  const list = await getSetting<LikeEntry[]>(LIKES_KEY, []);
  const today = beijingDay(now);
  let groupToday = 0;
  let userToday = 0;
  let lastGroupAt: number | undefined;
  for (const e of list) {
    if (e.chatId === chatId) {
      if (lastGroupAt === undefined || e.at > lastGroupAt) lastGroupAt = e.at;
      if (beijingDay(e.at) === today) groupToday += 1;
    }
    if (e.openId === openId && beijingDay(e.at) === today) userToday += 1;
  }
  return { groupToday, userToday, lastGroupAt };
}

/** 原子消费一次「今日 LLM 评估预算」:今日已用 < budget 则 +1 返回 true,否则 false。
 *  必须在真正调用 LLM 评分【之前】调用,用返回值决定要不要评估(控成本)。 */
export async function tryConsumeEvalBudget(now: number, budget: number): Promise<boolean> {
  return withLock(async () => {
    const day = beijingDay(now);
    const buckets = await getSetting<Record<string, number>>(EVAL_DAILY_KEY, {});
    // GC:只留最近 EVAL_DAILY_KEEP 天(ISO 日期串字典序即时间序)。
    const days = Object.keys(buckets).sort();
    while (days.length > EVAL_DAILY_KEEP) {
      const d = days.shift();
      if (d) delete buckets[d];
    }
    const used = buckets[day] ?? 0;
    if (used >= budget) {
      await setSetting(EVAL_DAILY_KEY, buckets, "system:group-qa");
      return false;
    }
    buckets[day] = used + 1;
    await setSetting(EVAL_DAILY_KEY, buckets, "system:group-qa");
    return true;
  });
}
