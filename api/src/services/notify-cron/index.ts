// 飞书群通知的「定时类」自动任务,在 API 进程内自调度(北京时间):
//   - weekly_digest:本周周报(默认 每周五 21:00)
//   - doc_audit:   知识库文档体检(默认 工作日 09:00)
//
// 触发时刻(星期多选 / 时:分 / 是否每周重复)由管理后台「飞书群通知」配置,
// 存 DB(见 notify-config 的 ScenarioCronSchedule);后台改完路由层调用
// rescheduleNotifyCron(key) 即时重排,无需重启。repeat=false 表示「仅执行
// 一次」:实际执行(开关开着、有目标群)后自动停用(enabled=false)。
//
// 在进程内调度，与在线服务同用户/同环境，LLM 命令行的可用性与后台「发送测试」完全一致
// (系统 crontab 跑独立脚本时，常因环境里找不到 LLM CLI 而失败)。
// 脚本(scripts/weekly-role-digest.ts / doc-audit.ts)保留作手动补发工具；
// 服务已按后台配置自动推送，不要再另配系统定时任务，否则同一个群会收到两份。
import type { FastifyBaseLogger } from "fastify";
import { msUntilNextBeijing } from "../../utils/beijingWeek.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { isRestoring } from "../backup.js";
import {
  getScenarioNotifyConfig, setScenarioNotifyConfig, chatLabel,
  DEFAULT_SCHEDULES, type ScenarioKey,
} from "../notify-config/index.js";
import { generateWeeklyDigest } from "../role-digest/run.js";
import { runDocAudit } from "../doc-audit/run.js";
import { markScenarioRunning } from "../notify-test/running.js";
import { buildKbWeeklyReportCard } from "../weekly-report-image/scenario.js";

interface CronJobDef {
  key: ScenarioKey;
  label: string;
  buildCard(now: Date): Promise<unknown>;
}

const JOBS: CronJobDef[] = [
  { key: "weekly_digest", label: "本周周报", buildCard: async (now) => (await generateWeeklyDigest(now)).card },
  { key: "doc_audit", label: "文档体检", buildCard: async (now) => (await runDocAudit(now)).card },
  { key: "kb_weekly_report", label: "知识库周报(图片)", buildCard: async (now) => buildKbWeeklyReportCard(now) },
];

/** 到点执行一个任务:开关/目标群检查 → 组卡片(可能含 LLM,慢)→ 逐群
 *  best-effort 发送 → 单次任务自动停用。任何失败只记日志,绝不抛出(抛了会
 *  断掉自调度链)。返回是否实际执行了发送(供单测断言)。 */
async function fireJob(job: CronJobDef, log?: FastifyBaseLogger): Promise<boolean> {
  if (isRestoring()) {
    log?.warn({ key: job.key }, "notify cron skipped: backup restoring");
    return false;
  }
  let cfg: Awaited<ReturnType<typeof getScenarioNotifyConfig>>;
  try {
    cfg = await getScenarioNotifyConfig(job.key);
  } catch (err) {
    log?.error({ err, key: job.key }, "notify cron config read failed");
    return false;
  }
  if (!cfg.enabled) {
    log?.info({ key: job.key }, "notify cron skipped: 自动任务已关闭");
    return false;
  }
  if (cfg.chatIds.length === 0) {
    log?.warn({ key: job.key }, "notify cron skipped: 未勾选目标群");
    return false;
  }
  const release = markScenarioRunning(job.key);
  try {
    const card = await job.buildCard(new Date());
    for (const chatId of cfg.chatIds) {
      try {
        await feishuGateway.notifyChat(chatId, card);
        log?.info({ key: job.key, chat: chatLabel(chatId) }, "notify cron sent");
      } catch (err) {
        log?.error({ err, key: job.key, chat: chatLabel(chatId) }, "notify cron send failed");
      }
    }
  } catch (err) {
    log?.error({ err, key: job.key }, "notify cron build failed");
  } finally {
    release();
  }
  // 仅执行一次:发完自动停用。失败也算"执行过"(避免每周重试发旧一次性任务);
  // 想再来一次,后台重新开启即可。
  if (cfg.schedule && !cfg.schedule.repeat) {
    await setScenarioNotifyConfig(job.key, { enabled: false }, "system:notify-cron")
      .then(() => log?.info({ key: job.key }, "notify cron one-shot done, 自动任务已停用"))
      .catch((err) => log?.error({ err, key: job.key }, "notify cron one-shot disable failed"));
  }
  return true;
}

// ── 调度器状态(单实例)──────────────────────────────────────────
let schedulerLog: FastifyBaseLogger | undefined;
let started = false;
const timers = new Map<ScenarioKey, ReturnType<typeof setTimeout>>();
// armJob 的代数:clearTimeout 与 timers.set 之间隔着一段 await(读 DB 配置),
// 两次 armJob 重叠时(后台 PATCH 撞上定时器自触发重排)双方都清掉同一个旧
// timer、再各自 set —— 先回来的那只落不进 Map,泄漏且照常触发 → 同一任务双发。
// 每次 armJob 领新代数,await 回来发现已被更新的调用顶掉就放弃。
const armEpochs = new Map<ScenarioKey, number>();

/** 按当前 DB 配置(重新)安排一个任务的下一次触发。 */
async function armJob(job: CronJobDef): Promise<void> {
  if (!started) return;
  const epoch = (armEpochs.get(job.key) ?? 0) + 1;
  armEpochs.set(job.key, epoch);
  const prev = timers.get(job.key);
  if (prev) clearTimeout(prev);
  let sched;
  try {
    sched = (await getScenarioNotifyConfig(job.key)).schedule;
  } catch (err) {
    schedulerLog?.error({ err, key: job.key }, "notify cron schedule read failed; fallback to default");
    sched = DEFAULT_SCHEDULES[job.key] ?? null;
  }
  if (!started || armEpochs.get(job.key) !== epoch) return; // await 期间被 stop / 被更新的 armJob 顶掉
  if (!sched || sched.weekdays.length === 0) {
    schedulerLog?.warn({ key: job.key }, "notify cron not armed: 无有效触发时刻");
    return;
  }
  const delay = msUntilNextBeijing(sched.weekdays, sched.hour, sched.minute, new Date());
  const t = setTimeout(async () => {
    // 防早触发:定时器可能比墙钟边界早醒几毫秒,此时「距下一次」仍是到本次
    // 时点的一小段(< 1 分钟)→ 只重排剩余,不执行;准点/晚醒时该值已跳到
    // 下一个周期(≥ 1 天),正常执行。
    if (msUntilNextBeijing(sched.weekdays, sched.hour, sched.minute, new Date()) < 60_000) {
      void armJob(job);
      return;
    }
    await fireJob(job, schedulerLog);
    void armJob(job); // 按(可能已被后台改过的)最新配置排下一次
  }, Math.max(delay, 1000));
  t.unref?.();
  timers.set(job.key, t);
  schedulerLog?.info({ key: job.key, nextInMs: delay, schedule: sched }, "notify cron scheduled");
}

/** 后台改了触发时刻/配置后调用:立即按新配置重排该任务(非定时场景为 no-op)。 */
export function rescheduleNotifyCron(key: ScenarioKey): void {
  const job = JOBS.find((j) => j.key === key);
  if (!job || !started) return;
  void armJob(job);
}

/** 启动调度(真实服务进程,index.ts 调用)。返回停止函数。 */
export function startNotifyCronScheduler(log?: FastifyBaseLogger): () => void {
  schedulerLog = log;
  started = true;
  for (const job of JOBS) void armJob(job);
  return () => {
    started = false;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}

/** 仅供测试:直接触发一个任务(绕过调度器)。 */
export const __testing = { fireJob, JOBS };
