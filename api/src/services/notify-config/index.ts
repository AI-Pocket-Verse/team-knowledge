// 飞书群通知的「控制台配置」:每个通知场景可在管理后台(系统设置 → 飞书群通知)
// 配置 ① 是否开启自动任务 ② 发往哪些群(多选)。每个场景存独立的 Setting 行
// (feishu-notify.scenario.<key>),.env 里的 FEISHU_*_CHAT_IDS 仅作【默认值】
// (未配置过时的初始勾选)。
//
// 存储为什么按场景拆行:早期版本五个场景共用一个 JSON 行,两个 PATCH 并发(双开
// 标签页/两位管理员)读-改-写会整包互相覆盖;拆行后不同场景天然隔离,同场景的
// 合并再用事务串行化(见 setScenarioNotifyConfig)。旧的合并行仍被读取作为一次性
// 迁移回退(只读不写)。
//
// 读取方:三个事件触发器(Skill 更新 / 会议纪要 / 更新日志)+ 进程内定时调度器
// (services/notify-cron:周报 / 文档体检)。定时类场景的触发时刻(星期/时:分/
// 是否每周重复)也存在这里,后台改完由路由层通知调度器即时重排。
import { env } from "../../env.js";
import { prisma } from "../../db.js";
import { getSetting } from "../settings.js";
import { observedChatIds } from "../group-qa/buffer.js";

export const SCENARIO_KEYS = ["skill_updated", "weekly_digest", "meeting_minutes", "doc_audit", "changelog", "kb_weekly_report", "group_qa"] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

const KEY_PREFIX = "feishu-notify.scenario.";
const LEGACY_KEY = "feishu-notify.config"; // 旧版合并行,仅作读取回退

/** 定时类场景的触发时刻配置(北京时间)。weekdays 用 ISO 编号 1=周一…7=周日;
 *  repeat=false 表示「仅执行一次」:触发并实际执行后自动停用(enabled=false),
 *  再次开启会按当前配置安排下一次。 */
export interface ScenarioCronSchedule {
  weekdays: number[];
  hour: number;
  minute: number;
  repeat: boolean;
}

/** 定时类场景的默认触发时刻(后台没改过时生效);event 类场景无此项。 */
export const DEFAULT_SCHEDULES: Partial<Record<ScenarioKey, ScenarioCronSchedule>> = {
  weekly_digest: { weekdays: [5], hour: 21, minute: 0, repeat: true },
  doc_audit: { weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0, repeat: true },
  kb_weekly_report: { weekdays: [1], hour: 9, minute: 0, repeat: true },
};

/** 防御性归一:存储被手改/损坏时回退默认,字段逐项夹紧到合法域。 */
function normalizeSchedule(raw: Partial<ScenarioCronSchedule> | undefined, def: ScenarioCronSchedule): ScenarioCronSchedule {
  if (!raw) return { ...def, weekdays: [...def.weekdays] };
  const weekdays = Array.isArray(raw.weekdays)
    ? [...new Set(raw.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
    : [];
  const int = (v: unknown, min: number, max: number, fallback: number) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fallback;
  return {
    weekdays: weekdays.length > 0 ? weekdays : [...def.weekdays],
    hour: int(raw.hour, 0, 23, def.hour),
    minute: int(raw.minute, 0, 59, def.minute),
    repeat: typeof raw.repeat === "boolean" ? raw.repeat : def.repeat,
  };
}

interface StoredScenario {
  enabled?: boolean;
  chatIds?: string[];
  schedule?: Partial<ScenarioCronSchedule>;
}
type LegacyStored = Partial<Record<ScenarioKey, StoredScenario>>;

// 同一个非法 id 只告警一次,避免 availableChats 高频调用刷日志。
const warnedBadIds = new Set<string>();

function parseIds(raw: string): string[] {
  const out: string[] = [];
  if (!raw) return out; // env 变量未设置(理论上有 zod 默认 "";防御测试 mock 缺字段)
  for (const token of raw.split(",")) {
    const s = token.trim();
    if (!s) continue;
    if (s.startsWith("oc_")) {
      out.push(s);
    } else if (!warnedBadIds.has(s)) {
      warnedBadIds.add(s);
      console.warn(`[notify-config] 忽略非 oc_ 开头的群聊 id:「${s}」(请检查 FEISHU_*_CHAT_IDS / FEISHU_CHAT_NAMES)`);
    }
  }
  return out;
}

/** 该场景的 env 默认目标群(管理后台没配置过时的初始值)。 */
export function envDefaultChatIds(key: ScenarioKey): string[] {
  switch (key) {
    case "skill_updated": return parseIds(env.FEISHU_SKILL_NOTIFY_CHAT_IDS);
    case "weekly_digest": return parseIds(env.FEISHU_WEEKLY_DIGEST_CHAT_IDS);
    case "meeting_minutes": return parseIds(env.FEISHU_MEETING_NOTIFY_CHAT_IDS);
    case "doc_audit": return parseIds(env.FEISHU_DOC_AUDIT_NOTIFY_CHAT_IDS);
    case "changelog": return parseIds(env.FEISHU_CHANGELOG_NOTIFY_CHAT_IDS);
    case "kb_weekly_report": return parseIds(env.FEISHU_KB_WEEKLY_REPORT_CHAT_IDS);
    // 群聊智能答疑:被动触发,默认不预选群(敏感,管理员在后台显式勾选要监听的群)。
    case "group_qa": return [];
  }
}

/** chat_id → 群名映射(来自 FEISHU_CHAT_NAMES,格式 oc_id=群名,逗号分隔)。 */
export function parseChatNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of env.FEISHU_CHAT_NAMES.split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim();
    const name = pair.slice(i + 1).trim();
    if (id && name) out[id] = name;
  }
  return out;
}

export function chatLabel(chatId: string): string {
  return parseChatNames()[chatId] ?? chatId;
}

export interface ChatTarget {
  chatId: string;
  name: string;
}

/** 可供勾选的群列表:FEISHU_CHAT_NAMES 里命名过的群 ∪ 各场景 env 默认里出现过的群
 *  (没起名的回退显示 chat_id)。 */
export function availableChats(): ChatTarget[] {
  const names = parseChatNames();
  const ids = new Set<string>(Object.keys(names));
  for (const key of SCENARIO_KEYS) for (const id of envDefaultChatIds(key)) ids.add(id);
  // 机器人实际收到过消息的群也列为可勾选 —— 让不在 FEISHU_CHAT_NAMES 里、但机器人确在的
  // 群也能在后台开启「群聊智能答疑」(没起名的回退显示 chat_id;重启后随新消息重建)。
  for (const id of observedChatIds()) ids.add(id);
  return [...ids].map((chatId) => ({ chatId, name: names[chatId] ?? chatId }));
}

export interface ScenarioNotifyConfig {
  enabled: boolean;
  chatIds: string[];
  /** 定时类场景的触发时刻(存过用存的,否则默认);event 类场景为 null。 */
  schedule: ScenarioCronSchedule | null;
}

/** 读取该场景的存储配置:优先独立行,缺失时回退旧版合并行(一次性迁移读)。 */
async function readStored(key: ScenarioKey): Promise<StoredScenario> {
  const own = await getSetting<StoredScenario | null>(KEY_PREFIX + key, null);
  if (own) return own;
  const legacy = await getSetting<LegacyStored>(LEGACY_KEY, {});
  return legacy[key] ?? {};
}

/** 解析后的场景配置:后台存过用存的,没存过回退默认 —— enabled 默认【关】
 *  (自动任务须管理员在后台显式开启),chatIds 默认 env 全选(开启后即指向
 *  预期的群,不用再逐个勾)。已选群与「当前可选群」取交集 —— 某群从 env 名单
 *  移除后立即停发,也不会把孤儿 id 留在配置里卡死后续保存。 */
export async function getScenarioNotifyConfig(key: ScenarioKey): Promise<ScenarioNotifyConfig> {
  const stored = await readStored(key);
  const available = new Set(availableChats().map((c) => c.chatId));
  const raw = stored.chatIds ?? envDefaultChatIds(key);
  const def = DEFAULT_SCHEDULES[key];
  return {
    enabled: stored.enabled ?? false,
    chatIds: raw.filter((id) => available.has(id)),
    schedule: def ? normalizeSchedule(stored.schedule, def) : null,
  };
}

export async function setScenarioNotifyConfig(
  key: ScenarioKey,
  patch: { enabled?: boolean; chatIds?: string[]; schedule?: ScenarioCronSchedule },
  updatedBy: string,
): Promise<ScenarioNotifyConfig> {
  if (patch.chatIds) {
    const ok = new Set(availableChats().map((c) => c.chatId));
    for (const id of patch.chatIds) {
      if (!ok.has(id)) throw new Error(`未知的群聊 id:${id}`);
    }
  }
  if (patch.schedule) {
    const def = DEFAULT_SCHEDULES[key];
    if (!def) throw new Error("该任务由业务事件触发,不支持配置定时时刻");
    // 归一(去重/排序/夹紧)后落库,读取端的 normalize 只是防御手改。
    patch = { ...patch, schedule: normalizeSchedule(patch.schedule, def) };
  }
  // 事务内读-改-写,串行化同场景的并发 PATCH(不同场景已按行天然隔离)。
  const settingKey = KEY_PREFIX + key;
  await prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: settingKey } });
    let cur: StoredScenario = {};
    if (row) {
      try { cur = JSON.parse(row.value) as StoredScenario; } catch { /* 损坏即重建 */ }
    } else {
      // 首次写入:把旧版合并行里的该场景搬过来,别丢掉历史配置。
      const legacyRow = await tx.setting.findUnique({ where: { key: LEGACY_KEY } });
      if (legacyRow) {
        try { cur = (JSON.parse(legacyRow.value) as LegacyStored)[key] ?? {}; } catch { /* ignore */ }
      }
    }
    const merged = JSON.stringify({ ...cur, ...patch });
    await tx.setting.upsert({
      where: { key: settingKey },
      update: { value: merged, updatedBy },
      create: { key: settingKey, value: merged, updatedBy },
    });
  });
  return getScenarioNotifyConfig(key);
}

/** 自动任务(事件/定时)发送前调用:未开启 → 空数组(= 不发),开启 → 已选群。 */
export async function targetsIfEnabled(key: ScenarioKey): Promise<string[]> {
  const c = await getScenarioNotifyConfig(key);
  return c.enabled ? c.chatIds : [];
}
