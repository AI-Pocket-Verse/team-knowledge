// 自动化调度器:进程内每 TICK_MS 扫一次「enabled && nextRunAt<=now」的任务,逐个执行,
// 执行后按调度重算 nextRunAt(单次/到期 → null,移出「已安排」)。nextRunAt 落库 → 重启安全。
// 启动对账:错过的(nextRunAt 缺失/已过)重算到下一个未来时刻,【不补跑】,避免部署后一阵猛跑;
// 同时把重启前中断的 running 运行记录标记为 failed(孤儿清理)。
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../db.js";
import { isRestoring } from "../backup.js";
import { computeNextRun, retryDelayMs, MAX_AUTOMATION_RETRIES, type ScheduleKind, type ScheduleConfig, type IntervalConfig } from "./schedule.js";
import { runAutomation } from "./run.js";

const TICK_MS = 30_000;
const running = new Set<string>(); // 防重入:同一任务上一次没跑完不再触发

function boundsOf(a: { effectiveFrom: Date | null; effectiveTo: Date | null }): { from?: number | null; to?: number | null } {
  return { from: a.effectiveFrom?.getTime() ?? null, to: a.effectiveTo?.getTime() ?? null };
}

// 按任务当前调度重算「下一次」;写回 nextRunAt(null = 不再调度)。
// interval:按【计划节拍】(上次计划时刻 + everyMs)推进,而非「完成时刻 + everyMs」,避免执行耗时累积漂移;
// 错过多个周期则跳到下一个未来节拍(不补跑)。cron 本身是墙钟对齐、once 到期即 null,直接按 now 重算即可。
async function advance(id: string, log?: FastifyBaseLogger, status?: "success" | "failed" | "undeliverable"): Promise<void> {
  const a = await prisma.automation.findUnique({ where: { id } });
  if (!a || !a.enabled) return;

  // 失败(LLM 无产出 / 超时 / 5xx)且未达重试上限 → 指数退避重试;undeliverable(webhook 4xx 等)不重试:把 nextRunAt 排到 now+退避,retryCount+1,不动正常调度节拍。
  // 超出生效区间则放弃重试、按正常处理。测试运行不走 advance,故不会重试。
  if (status === "failed" && a.retryCount < MAX_AUTOMATION_RETRIES) {
    const delay = retryDelayMs(a.retryCount);
    const retryAtMs = Date.now() + delay;
    const toMs = a.effectiveTo?.getTime();
    if (toMs == null || retryAtMs <= toMs) {
      try {
        await prisma.automation.update({ where: { id }, data: { nextRunAt: new Date(retryAtMs), retryCount: a.retryCount + 1 } });
        log?.warn?.({ id, attempt: a.retryCount + 1, max: MAX_AUTOMATION_RETRIES, delayMs: delay }, "[automation] 运行失败,已安排退避重试");
      } catch (e) {
        log?.warn?.({ err: e, id }, "[automation] 重试写回失败");
      }
      return;
    }
    // 落在生效区间之外 → 不再重试,继续走下面的正常推进(会重置 retryCount)。
  }

  // 正常推进(成功 / 重试用尽 / 不可重试):算下一次并把 retryCount 归零。
  // interval:按【计划节拍】(上次计划时刻 + everyMs)推进,避免执行耗时累积漂移;错过多个则跳到下一个未来节拍。
  let next: Date | null = null;
  try {
    const cfg = JSON.parse(a.scheduleConfig) as ScheduleConfig;
    if (a.scheduleKind === "interval" && a.nextRunAt) {
      const everyMs = (cfg as IntervalConfig).everyMs;
      const nowMs = Date.now();
      let n = a.nextRunAt.getTime() + everyMs;
      while (n <= nowMs) n += everyMs; // 跳过错过的节拍到下一个未来时刻
      const toMs = a.effectiveTo?.getTime();
      next = toMs != null && n > toMs ? null : new Date(n);
    } else {
      next = computeNextRun(a.scheduleKind as ScheduleKind, cfg, new Date(), boundsOf(a));
    }
  } catch { next = null; }
  // 单次(once)跑完就没有下一次了 → 顺手 disable,移出「已安排」的活跃态(否则永远 enabled 挂着)。
  const disable = a.scheduleKind === "once" && next === null;
  try {
    await prisma.automation.update({ where: { id }, data: { nextRunAt: next, retryCount: 0, ...(disable ? { enabled: false } : {}) } });
  } catch (e) {
    // 写回失败会让 nextRunAt 停在过去 → 下个 tick 反复重触发;至少要能从日志看到。
    log?.warn?.({ err: e, id }, "[automation] advance 写回 nextRunAt 失败");
  }
}

export async function tick(log?: FastifyBaseLogger): Promise<void> {
  if (isRestoring()) return; // 恢复备份期间不跑
  const now = new Date();
  const due = await prisma.automation.findMany({ where: { enabled: true, nextRunAt: { lte: now }, user: { isActive: true } }, select: { id: true } });
  for (const { id } of due) {
    if (running.has(id)) continue;
    running.add(id);
    // 不 await:各任务并发跑(真正的 LLM 并发由 callGeneralLlm 的 chatSemaphore 限流)。
    // 仅在真正执行(非 skipped,如手动测试运行正占用)后才推进 nextRunAt;skipped 时保留旧值,下个 tick 再试。
    void runAutomation(id, { log })
      .then((status) => (status === "skipped" ? undefined : advance(id, log, status)))
      .catch(() => {})
      .finally(() => running.delete(id));
  }
}

/** 启动对账:清理孤儿 running 记录 + enabled 任务若 nextRunAt 缺失/已过 → 重算到下一个未来时刻(跳过错过的,不补跑)。 */
async function reconcile(log?: FastifyBaseLogger): Promise<void> {
  // 进程重启时,任何 status=running 的运行记录都是被中断的孤儿 → 标记为 failed。
  await prisma.automationRun.updateMany({
    where: { status: "running" },
    data: { status: "failed", finishedAt: new Date(), error: "服务重启,运行中断" },
  }).catch((e) => log?.warn?.({ err: e }, "[automation] 清理孤儿运行记录失败"));

  const now = new Date();
  const tasks = await prisma.automation.findMany({ where: { enabled: true } });
  for (const a of tasks) {
    if (a.nextRunAt && a.nextRunAt > now) continue;
    let next: Date | null = null;
    try { next = computeNextRun(a.scheduleKind as ScheduleKind, JSON.parse(a.scheduleConfig) as ScheduleConfig, now, boundsOf(a)); }
    catch { next = null; }
    // 重排到正常下一次的同时归零重试计数(重启后从干净状态开始)。
    await prisma.automation.update({ where: { id: a.id }, data: { nextRunAt: next, retryCount: 0 } }).catch(() => {});
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutomationScheduler(log?: FastifyBaseLogger): void {
  if (timer) return;
  void reconcile(log)
    .catch((e) => log?.warn?.({ err: e }, "[automation] reconcile failed"))
    .finally(() => {
      timer = setInterval(() => void tick(log), TICK_MS);
      timer.unref?.();
    });
}
