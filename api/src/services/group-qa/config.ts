// 群聊智能答疑「互动节奏」运行参数(管理后台可配;复用 Setting 键值存储,免迁移)。
// 决定机器人在群里主动答疑是「频繁」还是「克制」:
//   cooldownSec     同群两次主动回答的最短间隔(秒)—— 越大越克制
//   hourlyCap       每群每小时主动回答上限(条)—— 防刷屏
//   dedupMin        同一问题多少分钟内不重复答(去重窗口)
//   demoteDays      被「👎 没帮助」的问题降权保留天数(TTL 内同问题不再答)
//   answerCap       单条答案字数上限(同时注入 LLM prompt 与硬截断)
//   aggressiveness  答疑积极度 1-3:决定 LLM「该不该答」的松紧 + 检索候选数。
//                   1 保守(只答高度对题,拿不准不答)/ 2 适中(相关有用就答)/ 3 积极
//                   (沾边能帮上忙就答)。这是「克制↔频繁」的主闸门 —— 前面几项只是限流阀,
//                   真正决定开不开口的是这里的判定门槛。三档各对应不同 prompt 与检索数,
//                   每档切换都有实感(不做 LLM 难以稳定区分的更细分级)。
// 默认值取「偏频繁」的一档(比早期硬编码的保守值更愿意搭话);越界/脏值由 clampInt 夹紧
// 回退默认(复用 doc-audit 同款纯函数)。gate.ts / answer.ts / store.ts 的硬编码常量仅作
// 「不传配置」时的兜底(测试用),与这里的默认可以不同 —— 运行时一律以本文件配置为准。
import { getSetting, setSetting } from "../settings.js";
import { clampInt } from "../doc-audit/config.js";

const COOLDOWN_SEC_KEY = "group-qa.cooldown_sec";
const HOURLY_CAP_KEY = "group-qa.hourly_cap";
const DEDUP_MIN_KEY = "group-qa.dedup_min";
const DEMOTE_DAYS_KEY = "group-qa.demote_days";
const ANSWER_CAP_KEY = "group-qa.answer_cap";
const AGGRESSIVENESS_KEY = "group-qa.aggressiveness";

// 默认改为「偏频繁」档:间隔更短、上限更高、去重/降权更短、积极度适中偏上。
export const COOLDOWN_SEC_DEFAULT = 15;
export const COOLDOWN_SEC_MIN = 5;
export const COOLDOWN_SEC_MAX = 3600;
export const HOURLY_CAP_DEFAULT = 20;
export const HOURLY_CAP_MIN = 1;
export const HOURLY_CAP_MAX = 100;
export const DEDUP_MIN_DEFAULT = 10;
export const DEDUP_MIN_MIN = 1;
export const DEDUP_MIN_MAX = 1440; // 24h
export const DEMOTE_DAYS_DEFAULT = 3;
export const DEMOTE_DAYS_MIN = 1;
export const DEMOTE_DAYS_MAX = 90;
export const ANSWER_CAP_DEFAULT = 160;
export const ANSWER_CAP_MIN = 40;
export const ANSWER_CAP_MAX = 1000;
export const AGGRESSIVENESS_DEFAULT = 2; // 适中(1 保守 / 2 适中 / 3 积极)
export const AGGRESSIVENESS_MIN = 1;
export const AGGRESSIVENESS_MAX = 3;

export interface GroupQaTuning {
  cooldownSec: number;
  hourlyCap: number;
  dedupMin: number;
  demoteDays: number;
  answerCap: number;
  aggressiveness: number;
}

export async function getGroupQaTuning(): Promise<GroupQaTuning> {
  const [c, h, d, dm, a, ag] = await Promise.all([
    getSetting(COOLDOWN_SEC_KEY, COOLDOWN_SEC_DEFAULT),
    getSetting(HOURLY_CAP_KEY, HOURLY_CAP_DEFAULT),
    getSetting(DEDUP_MIN_KEY, DEDUP_MIN_DEFAULT),
    getSetting(DEMOTE_DAYS_KEY, DEMOTE_DAYS_DEFAULT),
    getSetting(ANSWER_CAP_KEY, ANSWER_CAP_DEFAULT),
    getSetting(AGGRESSIVENESS_KEY, AGGRESSIVENESS_DEFAULT),
  ]);
  return {
    cooldownSec: clampInt(c, COOLDOWN_SEC_MIN, COOLDOWN_SEC_MAX, COOLDOWN_SEC_DEFAULT),
    hourlyCap: clampInt(h, HOURLY_CAP_MIN, HOURLY_CAP_MAX, HOURLY_CAP_DEFAULT),
    dedupMin: clampInt(d, DEDUP_MIN_MIN, DEDUP_MIN_MAX, DEDUP_MIN_DEFAULT),
    demoteDays: clampInt(dm, DEMOTE_DAYS_MIN, DEMOTE_DAYS_MAX, DEMOTE_DAYS_DEFAULT),
    answerCap: clampInt(a, ANSWER_CAP_MIN, ANSWER_CAP_MAX, ANSWER_CAP_DEFAULT),
    aggressiveness: clampInt(ag, AGGRESSIVENESS_MIN, AGGRESSIVENESS_MAX, AGGRESSIVENESS_DEFAULT),
  };
}

// ─── 群消息「AI 点赞」配置 ────────────────────────────────────────────────
// 机器人对它判定为「好」的群消息自动加飞书表情回复(👍)。点赞是稀缺正反馈,
// 默认从严(阈值高、频率低),且 enabled 默认关(灰度)。同样复用 Setting 键值。
//   enabled          总开关(默认关,飞书权限发布后再开)
//   threshold        LLM 质量分阈值 1-10,达到才点赞(越高越挑剔)
//   dailyCapPerGroup 每群每天点赞上限(防刷屏)
//   cooldownMin      同群两次点赞最短间隔(分钟)
//   userDailyCap     每人每天被点赞上限(防偏袒某人刷屏)
//   evalDailyBudget  每天最多用 LLM 评估多少条消息(控成本);预筛不计入
//   emoji            点赞用的飞书固定表情枚举(默认 THUMBSUP 👍)
const LIKE_ENABLED_KEY = "group-qa.like.enabled";
const LIKE_THRESHOLD_KEY = "group-qa.like.threshold";
const LIKE_DAILY_CAP_KEY = "group-qa.like.daily_cap_per_group";
const LIKE_COOLDOWN_MIN_KEY = "group-qa.like.cooldown_min";
const LIKE_USER_DAILY_CAP_KEY = "group-qa.like.user_daily_cap";
const LIKE_EVAL_BUDGET_KEY = "group-qa.like.eval_daily_budget";
const LIKE_EMOJI_KEY = "group-qa.like.emoji";
const LIKE_EMOJI_MODE_KEY = "group-qa.like.emoji_mode";

// 允许的点赞表情(飞书固定 emoji_type 枚举的一个安全子集)。改这里即扩选项。
export const LIKE_EMOJI_OPTIONS = ["THUMBSUP", "OK", "DONE", "HEART", "APPLAUSE", "FINGERHEART"] as const;
export type LikeEmoji = (typeof LIKE_EMOJI_OPTIONS)[number];

export const LIKE_ENABLED_DEFAULT = false;
export const LIKE_THRESHOLD_DEFAULT = 8;
export const LIKE_THRESHOLD_MIN = 1;
export const LIKE_THRESHOLD_MAX = 10;
export const LIKE_DAILY_CAP_DEFAULT = 2;
export const LIKE_DAILY_CAP_MIN = 1;
export const LIKE_DAILY_CAP_MAX = 50;
export const LIKE_COOLDOWN_MIN_DEFAULT = 45;
export const LIKE_COOLDOWN_MIN_MIN = 1;
export const LIKE_COOLDOWN_MIN_MAX = 1440;
export const LIKE_USER_DAILY_CAP_DEFAULT = 1;
export const LIKE_USER_DAILY_CAP_MIN = 1;
export const LIKE_USER_DAILY_CAP_MAX = 20;
export const LIKE_EVAL_BUDGET_DEFAULT = 100;
export const LIKE_EVAL_BUDGET_MIN = 10;
export const LIKE_EVAL_BUDGET_MAX = 5000;
export const LIKE_EMOJI_DEFAULT: LikeEmoji = "THUMBSUP";

// 表情模式:fixed = 一律用 emoji;smart = 评分时让 LLM 从白名单选合适表情,拿不准回退 emoji。
export const LIKE_EMOJI_MODES = ["fixed", "smart"] as const;
export type LikeEmojiMode = (typeof LIKE_EMOJI_MODES)[number];
export const LIKE_EMOJI_MODE_DEFAULT: LikeEmojiMode = "smart";

export interface GroupQaLikeConfig {
  enabled: boolean;
  threshold: number;
  dailyCapPerGroup: number;
  cooldownMin: number;
  userDailyCap: number;
  evalDailyBudget: number;
  emoji: LikeEmoji;      // smart 模式下作为「兜底表情」
  emojiMode: LikeEmojiMode;
}

function normalizeEmoji(v: unknown): LikeEmoji {
  return LIKE_EMOJI_OPTIONS.includes(v as LikeEmoji) ? (v as LikeEmoji) : LIKE_EMOJI_DEFAULT;
}

function normalizeEmojiMode(v: unknown): LikeEmojiMode {
  return LIKE_EMOJI_MODES.includes(v as LikeEmojiMode) ? (v as LikeEmojiMode) : LIKE_EMOJI_MODE_DEFAULT;
}

export async function getGroupQaLike(): Promise<GroupQaLikeConfig> {
  const [en, th, dc, cd, uc, bg, em, mode] = await Promise.all([
    getSetting<boolean>(LIKE_ENABLED_KEY, LIKE_ENABLED_DEFAULT),
    getSetting(LIKE_THRESHOLD_KEY, LIKE_THRESHOLD_DEFAULT),
    getSetting(LIKE_DAILY_CAP_KEY, LIKE_DAILY_CAP_DEFAULT),
    getSetting(LIKE_COOLDOWN_MIN_KEY, LIKE_COOLDOWN_MIN_DEFAULT),
    getSetting(LIKE_USER_DAILY_CAP_KEY, LIKE_USER_DAILY_CAP_DEFAULT),
    getSetting(LIKE_EVAL_BUDGET_KEY, LIKE_EVAL_BUDGET_DEFAULT),
    getSetting<string>(LIKE_EMOJI_KEY, LIKE_EMOJI_DEFAULT),
    getSetting<string>(LIKE_EMOJI_MODE_KEY, LIKE_EMOJI_MODE_DEFAULT),
  ]);
  return {
    enabled: en === true,
    threshold: clampInt(th, LIKE_THRESHOLD_MIN, LIKE_THRESHOLD_MAX, LIKE_THRESHOLD_DEFAULT),
    dailyCapPerGroup: clampInt(dc, LIKE_DAILY_CAP_MIN, LIKE_DAILY_CAP_MAX, LIKE_DAILY_CAP_DEFAULT),
    cooldownMin: clampInt(cd, LIKE_COOLDOWN_MIN_MIN, LIKE_COOLDOWN_MIN_MAX, LIKE_COOLDOWN_MIN_DEFAULT),
    userDailyCap: clampInt(uc, LIKE_USER_DAILY_CAP_MIN, LIKE_USER_DAILY_CAP_MAX, LIKE_USER_DAILY_CAP_DEFAULT),
    evalDailyBudget: clampInt(bg, LIKE_EVAL_BUDGET_MIN, LIKE_EVAL_BUDGET_MAX, LIKE_EVAL_BUDGET_DEFAULT),
    emoji: normalizeEmoji(em),
    emojiMode: normalizeEmojiMode(mode),
  };
}

// 入参 patch:emoji / emojiMode 收宽松 string(路由层不强枚举),非法值由 normalize* 回退默认。
export type GroupQaLikePatch = Partial<Omit<GroupQaLikeConfig, "emoji" | "emojiMode"> & { emoji: string; emojiMode: string }>;

/** 部分更新点赞配置(只写传入字段);数值越界夹紧、emoji 非法回退默认。 */
export async function setGroupQaLike(patch: GroupQaLikePatch, by: string): Promise<GroupQaLikeConfig> {
  if (patch.enabled !== undefined) {
    await setSetting(LIKE_ENABLED_KEY, patch.enabled === true, by);
  }
  if (patch.threshold !== undefined) {
    await setSetting(LIKE_THRESHOLD_KEY, clampInt(patch.threshold, LIKE_THRESHOLD_MIN, LIKE_THRESHOLD_MAX, LIKE_THRESHOLD_DEFAULT), by);
  }
  if (patch.dailyCapPerGroup !== undefined) {
    await setSetting(LIKE_DAILY_CAP_KEY, clampInt(patch.dailyCapPerGroup, LIKE_DAILY_CAP_MIN, LIKE_DAILY_CAP_MAX, LIKE_DAILY_CAP_DEFAULT), by);
  }
  if (patch.cooldownMin !== undefined) {
    await setSetting(LIKE_COOLDOWN_MIN_KEY, clampInt(patch.cooldownMin, LIKE_COOLDOWN_MIN_MIN, LIKE_COOLDOWN_MIN_MAX, LIKE_COOLDOWN_MIN_DEFAULT), by);
  }
  if (patch.userDailyCap !== undefined) {
    await setSetting(LIKE_USER_DAILY_CAP_KEY, clampInt(patch.userDailyCap, LIKE_USER_DAILY_CAP_MIN, LIKE_USER_DAILY_CAP_MAX, LIKE_USER_DAILY_CAP_DEFAULT), by);
  }
  if (patch.evalDailyBudget !== undefined) {
    await setSetting(LIKE_EVAL_BUDGET_KEY, clampInt(patch.evalDailyBudget, LIKE_EVAL_BUDGET_MIN, LIKE_EVAL_BUDGET_MAX, LIKE_EVAL_BUDGET_DEFAULT), by);
  }
  if (patch.emoji !== undefined) {
    await setSetting(LIKE_EMOJI_KEY, normalizeEmoji(patch.emoji), by);
  }
  if (patch.emojiMode !== undefined) {
    await setSetting(LIKE_EMOJI_MODE_KEY, normalizeEmojiMode(patch.emojiMode), by);
  }
  return getGroupQaLike();
}

/** 部分更新(只写传入字段);数值越界自动夹紧。返回更新后的完整设置。 */
export async function setGroupQaTuning(patch: Partial<GroupQaTuning>, by: string): Promise<GroupQaTuning> {
  if (patch.cooldownSec !== undefined) {
    await setSetting(COOLDOWN_SEC_KEY, clampInt(patch.cooldownSec, COOLDOWN_SEC_MIN, COOLDOWN_SEC_MAX, COOLDOWN_SEC_DEFAULT), by);
  }
  if (patch.hourlyCap !== undefined) {
    await setSetting(HOURLY_CAP_KEY, clampInt(patch.hourlyCap, HOURLY_CAP_MIN, HOURLY_CAP_MAX, HOURLY_CAP_DEFAULT), by);
  }
  if (patch.dedupMin !== undefined) {
    await setSetting(DEDUP_MIN_KEY, clampInt(patch.dedupMin, DEDUP_MIN_MIN, DEDUP_MIN_MAX, DEDUP_MIN_DEFAULT), by);
  }
  if (patch.demoteDays !== undefined) {
    await setSetting(DEMOTE_DAYS_KEY, clampInt(patch.demoteDays, DEMOTE_DAYS_MIN, DEMOTE_DAYS_MAX, DEMOTE_DAYS_DEFAULT), by);
  }
  if (patch.answerCap !== undefined) {
    await setSetting(ANSWER_CAP_KEY, clampInt(patch.answerCap, ANSWER_CAP_MIN, ANSWER_CAP_MAX, ANSWER_CAP_DEFAULT), by);
  }
  if (patch.aggressiveness !== undefined) {
    await setSetting(AGGRESSIVENESS_KEY, clampInt(patch.aggressiveness, AGGRESSIVENESS_MIN, AGGRESSIVENESS_MAX, AGGRESSIVENESS_DEFAULT), by);
  }
  return getGroupQaTuning();
}
