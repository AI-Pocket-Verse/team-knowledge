// 后台「飞书群通知」控制台:把所有【发往飞书群聊】的通知任务集中登记,管理员可
// ① 勾选每个任务的目标群(多选,存 Setting,见 ../notify-config)
// ② 开/关自动任务(定时 cron 或事件触发)
// ③ 手动「发送测试」一条真实卡片,验证样式 + 出站链路。
//
// 卡片复用生产同一个 builder:能用真实数据就用真实数据(周报/文档体检/会议纪要),
// 否则用清晰标注的示例数据(Skill 更新 —— 不该为测试真去重算 Skill)。
//
// 仅覆盖「群聊」通知(走 feishuGateway.notifyChat)。互动通知 / 新用户提醒 / assistant
// 提醒是 p2p 推给个人(notify),不在此列;助手提醒另有 /api/admin/assistant-notify。
import { randomUUID } from "node:crypto";
import { MEETING_SUMMARY_FAILED_PREFIX, CHANGELOG } from "@team-knowledge/shared";
import { prisma } from "../../db.js";
import { feishuGateway, FeishuGatewayError } from "../../utils/feishuGateway.js";
import { buildSkillUpdatedCard } from "../role-skill/notify.js";
import { buildMeetingMinutesCard } from "../meeting/notify.js";
import { EMPTY_MEETING_SUMMARY } from "../meeting/summary.js";
import { generateWeeklyDigest } from "../role-digest/run.js";
import { runDocAudit } from "../doc-audit/run.js";
import { buildChangelogCard } from "../changelog/notify.js";
import {
  SCENARIO_KEYS, type ScenarioKey, type ChatTarget, type ScenarioCronSchedule,
  availableChats, chatLabel, getScenarioNotifyConfig,
} from "../notify-config/index.js";
import { markScenarioRunning, scenarioRunningSince } from "./running.js";
import { buildKbWeeklyReportCard } from "../weekly-report-image/scenario.js";
import { buildGroupAnswerCard } from "../group-qa/card.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

/** 定时配置 → 人读文案,如「定时任务:每周五 21:00(北京时间)」。 */
export function formatCronSchedule(s: ScenarioCronSchedule): string {
  const NAMES = ["一", "二", "三", "四", "五", "六", "日"];
  const days =
    s.weekdays.length === 7 ? "每天"
    : s.weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => s.weekdays.includes(d)) ? "每个工作日（周一至周五）"
    : `每周${s.weekdays.map((d) => NAMES[d - 1]).join("、")}`;
  const hh = String(s.hour).padStart(2, "0");
  const mm = String(s.minute).padStart(2, "0");
  return `定时任务：${days} ${hh}:${mm}（北京时间）${s.repeat ? "" : "，仅执行一次（触发后自动停用）"}`;
}

export { SCENARIO_KEYS, type ScenarioKey, type ChatTarget };

const SAMPLE_MINUTES = `## 决策点
1. 确定登录页采用邀请码引导文案,本周内上线。
2. 会员页改版方案通过,去掉专属权益模块。

## 待办事项
1. 张三:完成语音通话页三键控制改造(本周五前)。
2. 李四:补齐 V1.2.3 测试用例缺口。

## 未解问题
1. 吃醋模式阶段阈值是否下调,待产品复核。

## 引用文档
无`;

export type SendFn = (chatId: string, card: unknown) => Promise<{ messageId: string }>;

interface ScenarioDef {
  key: ScenarioKey;
  title: string;
  description: string;
  /** 自动任务的触发方式:cron = 定时;event = 业务事件触发(无固定时刻)。 */
  triggerType: "cron" | "event";
  /** 人读的触发时机,如「每周五 21:00(北京时间)」。 */
  schedule: string;
  build(): Promise<unknown>;
}

const SCENARIOS: ScenarioDef[] = [
  {
    key: "skill_updated",
    title: "📘 角色 Skill 已更新",
    description: "角色 Skill 生成完成后推送到群的卡片。发送测试用示例数据,仅验证样式,不会真的重算 Skill。",
    triggerType: "event",
    schedule: "事件触发:角色 Skill 生成完成后自动发送",
    build: async () => {
      // 取一个真实角色,让「查看角色」按钮能真的跳到存在的角色页;无角色时兜底。
      const role = await prisma.role.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
      return buildSkillUpdatedCard({
        roleId: role?.id ?? "demo-role",
        roleName: `${role?.name ?? "测试角色"}(通知测试)`,
        docCount: 8,
        model: "claude",
        generatedAt: new Date(),
        changeSummary: "本次补充了「权限申请流程」与「邀请码奖励」两块能力说明,更新了打包发布的步骤,并移除了已废弃的旧登录流程描述。",
      });
    },
  },
  {
    key: "weekly_digest",
    title: "📊 本周周报",
    description:
      "「知识库更新 + 研发改动」周报。发送测试用本周真实数据跑完整链路(会拉 GitHub + LLM 简评,可能稍慢)。" +
      "注意:统计窗口固定为「本周一 00:00 → 触发时刻」(北京时间),把触发时刻改到周初会导致周报内容很少。",
    triggerType: "cron",
    schedule: "定时任务:每周五 21:00(北京时间)",
    build: async () => (await generateWeeklyDigest(new Date())).card,
  },
  {
    key: "meeting_minutes",
    title: "📝 会议纪要已生成",
    description: `${ASSISTANT_NAME} 会议结束并生成纪要后推送到群的卡片(附纪要正文 + 跳转链接)。发送测试优先取最近一场真实纪要,没有则用示例数据。`,
    triggerType: "event",
    schedule: "事件触发:会议纪要生成完成后自动发送",
    build: async () => {
      // 取最近一场已生成「真实纪要」的会议(排除空会议占位 / 失败标记),让卡片
      // 内容与「查看会议纪要」按钮都真实可用;无则兜底示例。
      const recent = await prisma.meetingSession.findMany({
        // 只取公开会议:卡片会发到群里,私密会议只有创建者能看。
        where: { status: "ended", visibility: "public", summaryMarkdown: { not: null }, deletedAt: null },
        orderBy: { endedAt: "desc" },
        take: 10,
        select: { id: true, title: true, summaryMarkdown: true, endedAt: true, createdAt: true },
      });
      const real = recent.find(
        (m) => m.summaryMarkdown && m.summaryMarkdown !== EMPTY_MEETING_SUMMARY && !m.summaryMarkdown.startsWith(MEETING_SUMMARY_FAILED_PREFIX),
      );
      return buildMeetingMinutesCard({
        meetingId: real?.id ?? "demo-meeting",
        title: real?.title ?? "测试会议(通知测试)",
        summaryMarkdown: real?.summaryMarkdown ?? SAMPLE_MINUTES,
        generatedAt: real?.endedAt ?? real?.createdAt ?? new Date(),
      });
    },
  },
  {
    key: "doc_audit",
    title: "📋 知识库文档体检",
    description: "对全部已发布文档跑 LLM 体检(找文档间不一致/逻辑错误/可优化点)。发送测试用真实文档跑完整链路(走 LLM,可能稍慢)。",
    triggerType: "cron",
    schedule: "定时任务:每个工作日(周一至周五)09:00(北京时间)",
    build: async () => (await runDocAudit(new Date(), { persist: false })).card,
  },
  {
    key: "changelog",
    title: "🚀 版本更新播报",
    description: "更新日志新增版本并部署上线后,自动向群推送最近一个或多个版本的更新内容摘要,点卡片按钮跳到「关于」页。发送测试推送当前最新版本。",
    triggerType: "event",
    schedule: "事件触发:部署重启后检测到新版本时自动发送(同一版本只播一次)",
    build: async () => buildChangelogCard(CHANGELOG.slice(0, 1)),
  },
  {
    key: "kb_weekly_report",
    title: "📊 知识库周报(图片)",
    description: "每周一把上一完整周的知识库周报渲染成图片发送到群,卡片内点击图片可放大。发送测试用真实数据出图(稍慢)。",
    triggerType: "cron",
    schedule: "定时任务:每周一 09:00(北京时间)",
    build: async () => buildKbWeeklyReportCard(new Date()),
  },
  {
    key: "group_qa",
    title: "💬 群聊智能答疑",
    description:
      "被动答疑:机器人读取所选群的消息,遇到「知识库能回答的问题/疑问」时,引用原消息并发一条简短答案(默认关闭,按群开启)。" +
      "需机器人具备 im:message.group_msg 权限(见 docs/feishu-bot.md)。「发送测试」发一张答疑样式预览卡到所选群(不针对具体消息)。",
    triggerType: "event",
    schedule: "被动触发:读取群消息,遇到知识库能答的问题时引用原消息并简短回答",
    build: async () =>
      buildGroupAnswerCard({
        quote: "报销流程是什么?",
        senderName: "示例同学",
        answer: "这是群聊智能答疑的样式预览。真机里我会在群里遇到知识库能答的问题时,引用那条消息并简短作答。",
        sourceTitle: "报销指南",
        hash: "sample",
      }),
  },
];

/** 给前端列表用的场景元信息(含已存配置)。 */
export interface ScenarioMeta {
  key: ScenarioKey;
  title: string;
  description: string;
  triggerType: "cron" | "event";
  schedule: string;
  /** 自动任务是否开启(关 = 定时/事件触发都不发,手动发送测试不受影响)。 */
  enabled: boolean;
  /** 可勾选的群(全部已知群)。 */
  available: ChatTarget[];
  /** 当前勾选的群 chat_id(available 的子集;默认 = env 默认 = 全选)。 */
  selected: string[];
  /** 此刻是否正在执行(定时触发或「发送测试」异步任务)—— 前端显示运行中动画。 */
  running: boolean;
  /** 定时类场景的结构化触发配置(后台可改);event 类为 null。 */
  cronSchedule: ScenarioCronSchedule | null;
}

export async function listScenarios(): Promise<ScenarioMeta[]> {
  const available = availableChats();
  return Promise.all(
    SCENARIOS.map(async ({ key, title, description, triggerType, schedule }) => {
      const cfg = await getScenarioNotifyConfig(key);
      return {
        key, title, description, triggerType,
        // 定时类场景按当前配置生成文案(后台改过时刻后跟着变);event 类用静态描述。
        schedule: cfg.schedule ? formatCronSchedule(cfg.schedule) : schedule,
        enabled: cfg.enabled, available, selected: cfg.chatIds,
        running: scenarioRunningSince(key) !== null,
        cronSchedule: cfg.schedule,
      };
    }),
  );
}

export function scenarioMetaByKey(key: string): Pick<ScenarioDef, "key" | "title" | "description" | "triggerType" | "schedule"> | null {
  const def = SCENARIOS.find((s) => s.key === key);
  return def ? { key: def.key, title: def.title, description: def.description, triggerType: def.triggerType, schedule: def.schedule } : null;
}

export interface SendResult {
  chatId: string;
  name: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** 未勾选目标群时抛出的可识别错误(路由据此回 400,而非当成 500)。 */
export class NoTargetError extends Error {
  code = "no_target" as const;
}

/**
 * 手动触发一个场景:组装卡片并逐群发送(发往已勾选的群;与「自动任务」开关无关)。
 * 逐群 best-effort —— 单个群失败只记在该条 result 上,不影响其它群。
 * `opts.send` / `opts.targets` 可注入(便于单测)。
 */
export async function sendScenario(
  key: string,
  opts: { send?: SendFn; targets?: string[] } = {},
): Promise<{ results: SendResult[] }> {
  const def = SCENARIOS.find((s) => s.key === key);
  if (!def) throw new Error(`未知的通知场景:${key}`);

  const targets = opts.targets ?? (await getScenarioNotifyConfig(def.key)).chatIds;
  if (targets.length === 0) {
    throw new NoTargetError(`「${def.title}」未勾选目标群聊,请先在下方勾选至少一个群。`);
  }

  const send = opts.send ?? feishuGateway.notifyChat;
  const card = await def.build();
  const results: SendResult[] = [];
  for (const chatId of targets) {
    const name = chatLabel(chatId);
    try {
      const r = await send(chatId, card);
      results.push({ chatId, name, ok: true, messageId: r.messageId });
    } catch (e) {
      // FeishuGatewayError 带飞书真实原因(机器人不在群 / 缺权限 / 群不存在等),
      // 比泛化的 code「feishu_upstream」有用得多 —— 优先把它透出来。
      const err =
        e instanceof FeishuGatewayError
          ? (e.feishuMessage?.trim() || `飞书返回错误(${e.code},HTTP ${e.status})`)
          : (e as Error).message;
      results.push({ chatId, name, ok: false, error: err });
    }
  }
  return { results };
}

// ─── 异步发送任务 ──────────────────────────────────────────────
// 周报/文档体检的「发送测试」要跑完整 LLM 链路(最长 2-3 分钟),同步扛在一个
// HTTP 请求里会撞上网关/代理超时。改为:POST 立即返回 jobId(202),后台执行,
// 前端轮询 GET 拿结果。内存 Map 即可(仅管理员控制台用,单实例部署)。

export interface SendJob {
  id: string;
  key: string;
  status: "running" | "done";
  startedAt: number;
  ok?: boolean;
  results?: SendResult[];
  /** 整体失败(组卡片阶段抛错等)时的原因;逐群失败在 results 里。 */
  error?: string;
  /** 测试用:await 它等任务完成(不对外序列化)。 */
  promise?: Promise<void>;
}

const JOB_TTL_MS = 10 * 60_000; // 完成后保留 10 分钟供查询,然后清掉
const sendJobs = new Map<string, SendJob>();

/** 该场景已在执行(定时触发或另一个「发送测试」)时抛出;路由据此回 409。 */
export class AlreadyRunningError extends Error {
  code = "already_running" as const;
}

export function startSendJob(key: string, opts: { send?: SendFn; targets?: string[] } = {}): SendJob {
  // 服务端并发防抖:前端的 sending 状态只挡同一标签页,双标签页/两位管理员仍可
  // 同时触发两条相同卡片 + 两条 LLM 链路。同步检查 + markScenarioRunning 在同一
  // tick 内完成,无竞态窗口。定时任务执行中也拒绝(此刻测试只会重复打扰群)。
  if (scenarioRunningSince(key) !== null) {
    throw new AlreadyRunningError("该任务正在执行中（定时触发或他人正在发送测试），请稍候再试。");
  }
  const job: SendJob = { id: randomUUID(), key, status: "running", startedAt: Date.now() };
  // 「发送测试」也算运行中:场景列表的 running 徽标与按钮 loading 一致。
  const release = markScenarioRunning(key);
  job.promise = sendScenario(key, opts)
    .then(({ results }) => {
      job.status = "done";
      job.ok = results.every((r) => r.ok);
      job.results = results;
    })
    .catch((e) => {
      job.status = "done";
      job.ok = false;
      job.error = (e as Error).message;
    })
    .finally(() => {
      release();
      // TTL 从「完成」起算:从创建起算的话,超过 TTL 的长任务会跑着跑着就被
      // 前端轮询 404(任务其实还在执行)。
      const cleanup = setTimeout(() => sendJobs.delete(job.id), JOB_TTL_MS);
      cleanup.unref?.();
    });
  sendJobs.set(job.id, job);
  return job;
}

export function getSendJob(id: string): SendJob | null {
  return sendJobs.get(id) ?? null;
}
