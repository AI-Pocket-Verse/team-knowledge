// 自动化任务的 CRUD 与 DTO 映射(归属个人;所有写操作带 userId 归属校验)。
import type { Automation, AutomationRun } from "@prisma/client";
import { prisma } from "../../db.js";
import { normalizeSchedule, computeNextRun, describeSchedule, type ScheduleKind, type ScheduleConfig } from "./schedule.js";
import { isAllowedWebhook } from "./webhook.js";
import { renderRunOutput } from "./render.js";

export interface AutomationInput {
  name: string;
  prompt: string;
  webhookUrl?: string | null;
  scheduleKind: ScheduleKind;
  scheduleConfig: unknown;
  effectiveFrom?: number | null; // epoch-ms
  effectiveTo?: number | null;
}

export interface AutomationRunDTO {
  id: string; automationId: string; automationName: string;
  startedAt: string; finishedAt: string | null;
  status: string; isTest: boolean; outputPreview: string | null;
  delivery: unknown | null; error: string | null;
}

export interface AutomationDTO {
  id: string; name: string; prompt: string; webhookUrl: string | null;
  scheduleKind: string; scheduleConfig: ScheduleConfig; scheduleLabel: string;
  effectiveFrom: string | null; effectiveTo: string | null;
  enabled: boolean; nextRunAt: string | null; runCount: number; lastRunStatus: string | null;
  pinnedAt: string | null;
  createdAt: string;
}

class InputError extends Error {}
export function isInputError(e: unknown): e is Error { return e instanceof InputError; }

// 校验并归一化输入(非法 → InputError,路由转 400);返回落库所需字段 + 计算好的 nextRunAt。
function prepare(input: AutomationInput, enabled: boolean): { data: Omit<AutomationInput, "scheduleConfig" | "effectiveFrom" | "effectiveTo"> & { scheduleConfig: string; effectiveFrom: Date | null; effectiveTo: Date | null }; nextRunAt: Date | null; cfg: ScheduleConfig } {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name) throw new InputError("名称不能为空");
  if (!prompt) throw new InputError("提示词不能为空");
  const webhookUrl = input.webhookUrl?.trim() || null;
  if (webhookUrl && !isAllowedWebhook(webhookUrl)) throw new InputError("webhook 地址不合法(仅支持飞书/Lark 机器人 webhook)");
  let cfg: ScheduleConfig;
  try { cfg = normalizeSchedule(input.scheduleKind, input.scheduleConfig); }
  catch (e) { throw new InputError((e as Error).message); }
  const from = input.effectiveFrom != null ? new Date(input.effectiveFrom) : null;
  const to = input.effectiveTo != null ? new Date(input.effectiveTo) : null;
  if (from && to && from.getTime() > to.getTime()) throw new InputError("生效起始不能晚于结束");
  const nextRunAt = enabled ? computeNextRun(input.scheduleKind, cfg, new Date(), { from: from?.getTime() ?? null, to: to?.getTime() ?? null }) : null;
  // 启用中却算不出下一次(单次时间已过 / 已超出生效区间)→ 保存后永不运行,提前报错而非静默。
  if (enabled && nextRunAt === null) throw new InputError("按当前设置不会有下一次运行(执行时间已过,或已超出生效日期区间)");
  return { data: { name, prompt, webhookUrl, scheduleKind: input.scheduleKind, scheduleConfig: JSON.stringify(cfg), effectiveFrom: from, effectiveTo: to }, nextRunAt, cfg };
}

export function mapAutomation(a: Automation): AutomationDTO {
  // 防御:scheduleConfig 理论上写入时必 stringify,但坏行不应让整个列表接口 500。
  let cfg: ScheduleConfig; let label: string;
  try { cfg = JSON.parse(a.scheduleConfig) as ScheduleConfig; label = describeSchedule(a.scheduleKind as ScheduleKind, cfg); }
  catch { cfg = {} as ScheduleConfig; label = "调度配置异常"; }
  return {
    id: a.id, name: a.name, prompt: a.prompt, webhookUrl: a.webhookUrl,
    scheduleKind: a.scheduleKind, scheduleConfig: cfg, scheduleLabel: label,
    effectiveFrom: a.effectiveFrom?.toISOString() ?? null, effectiveTo: a.effectiveTo?.toISOString() ?? null,
    enabled: a.enabled, nextRunAt: a.nextRunAt?.toISOString() ?? null, runCount: a.runCount, lastRunStatus: a.lastRunStatus,
    pinnedAt: a.pinnedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function mapRun(r: AutomationRun & { automation?: { name: string } }, name?: string): AutomationRunDTO {
  return {
    id: r.id, automationId: r.automationId, automationName: name ?? r.automation?.name ?? "",
    startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    status: r.status, isTest: r.isTest, outputPreview: r.outputPreview,
    delivery: r.delivery ? safeParse(r.delivery) : null, error: r.error,
  };
}
function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

// 惰性自愈:超过该时长仍 running 的记录视为「进程中断的孤儿」(正常一次运行含 LLM 180s + 投递,
// 远不到 15min),读列表/详情时顺手标记为失败。这样不必等进程重启,前端也不会对永不完成的 running
// 无限轮询。范围按 userId 收窄。
const RUN_STALE_MS = 15 * 60_000;
async function healStaleRuns(userId: string): Promise<void> {
  await prisma.automationRun.updateMany({
    where: { status: "running", automation: { userId }, startedAt: { lt: new Date(Date.now() - RUN_STALE_MS) } },
    data: { status: "failed", finishedAt: new Date(), error: "运行超时或已中断" },
  }).catch(() => {});
}

export const RUNS_PAGE_SIZE = 10;

/** 列表:本人全部任务 + 运行记录第一页(每页 10 条)+ 是否还有更早。 */
export async function listAutomations(userId: string): Promise<{ automations: AutomationDTO[]; recentRuns: AutomationRunDTO[]; runsHasMore: boolean }> {
  await healStaleRuns(userId);
  const automations = await prisma.automation.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  const { runs, hasMore } = await listRuns(userId);
  return { automations: automations.map(mapAutomation), recentRuns: runs, runsHasMore: hasMore };
}

/** 运行记录游标分页(按 startedAt desc,id 兜底稳定序)。cursor = 上一页最后一条 id;返回本页 + 是否还有更早。 */
export async function listRuns(userId: string, cursor?: string, limit = RUNS_PAGE_SIZE): Promise<{ runs: AutomationRunDTO[]; hasMore: boolean }> {
  await healStaleRuns(userId);
  const rows = await prisma.automationRun.findMany({
    where: { automation: { userId } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1, // 多取一条判断 hasMore
    include: { automation: { select: { name: true } } },
  });
  const hasMore = rows.length > limit;
  return { runs: rows.slice(0, limit).map((r) => mapRun(r)), hasMore };
}

/** 单个任务的运行记录游标分页(「已完成」每个任务折叠展开/加载更多用)。只取已完成(非 running)。
 *  归属校验:任务须属于本人,否则返回 null。cursor = 上一页最后一条 id。 */
export async function listRunsForAutomation(userId: string, automationId: string, cursor?: string, limit = 5): Promise<{ runs: AutomationRunDTO[]; hasMore: boolean } | null> {
  if ((await prisma.automation.count({ where: { id: automationId, userId } })) === 0) return null;
  await healStaleRuns(userId);
  const rows = await prisma.automationRun.findMany({
    where: { automationId, status: { not: "running" } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: { automation: { select: { name: true } } },
  });
  const hasMore = rows.length > limit;
  return { runs: rows.slice(0, limit).map((r) => mapRun(r)), hasMore };
}

export interface AutomationRunDetailDTO extends AutomationRunDTO {
  prompt: string;             // 任务提示词(阅读页顶部当作「用户气泡」展示)
  output: string | null;      // 完整产出原文(可能是卡片 JSON)
  displayText: string;        // 已转成可读 markdown(卡片摊平);阅读页直接渲染
}

/** 单条运行详情(归属校验:run 所属任务须属于本人)。找不到 → null。 */
export async function getRunDetail(userId: string, runId: string): Promise<AutomationRunDetailDTO | null> {
  await healStaleRuns(userId);
  const r = await prisma.automationRun.findFirst({
    where: { id: runId, automation: { userId } },
    include: { automation: { select: { name: true, prompt: true } } },
  });
  if (!r) return null;
  const output = r.output ?? r.outputPreview ?? null;
  return { ...mapRun(r), prompt: r.automation?.prompt ?? "", output, displayText: output ? renderRunOutput(output) : "" };
}

export async function getAutomation(userId: string, id: string): Promise<AutomationDTO | null> {
  const a = await prisma.automation.findFirst({ where: { id, userId } });
  return a ? mapAutomation(a) : null;
}

// 每人最多创建的任务数：每个任务都会定时联网调 LLM，不设上限可被用来占满后台并发。
export const MAX_AUTOMATIONS_PER_USER = 30;

export async function createAutomation(userId: string, input: AutomationInput): Promise<AutomationDTO> {
  const { data, nextRunAt } = prepare(input, true);
  const owned = await prisma.automation.count({ where: { userId } });
  if (owned >= MAX_AUTOMATIONS_PER_USER) throw new InputError(`每人最多创建 ${MAX_AUTOMATIONS_PER_USER} 个自动化任务，请先删除不用的任务`);
  const a = await prisma.automation.create({ data: { ...data, userId, enabled: true, nextRunAt } });
  return mapAutomation(a);
}

/** 更新(归属校验)。保留 enabled 现值:暂停中的任务改配置不会自动恢复。找不到 → null。 */
export async function updateAutomation(userId: string, id: string, input: AutomationInput): Promise<AutomationDTO | null> {
  const existing = await prisma.automation.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const { data, nextRunAt } = prepare(input, existing.enabled);
  const a = await prisma.automation.update({ where: { id }, data: { ...data, nextRunAt, retryCount: 0 } });
  return mapAutomation(a);
}

export async function setAutomationEnabled(userId: string, id: string, enabled: boolean): Promise<AutomationDTO | null> {
  const existing = await prisma.automation.findFirst({ where: { id, userId } });
  if (!existing) return null;
  let nextRunAt: Date | null = null;
  if (enabled) {
    try {
      nextRunAt = computeNextRun(existing.scheduleKind as ScheduleKind, JSON.parse(existing.scheduleConfig) as ScheduleConfig, new Date(),
        { from: existing.effectiveFrom?.getTime() ?? null, to: existing.effectiveTo?.getTime() ?? null });
    } catch { nextRunAt = null; }
  }
  const a = await prisma.automation.update({ where: { id }, data: { enabled, nextRunAt, retryCount: 0 } });
  return mapAutomation(a);
}

/** 置顶/取消置顶(归属校验)。pinned=true 记当前时刻、false 清空。找不到 → null。 */
export async function setAutomationPinned(userId: string, id: string, pinned: boolean): Promise<AutomationDTO | null> {
  const existing = await prisma.automation.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const a = await prisma.automation.update({ where: { id }, data: { pinnedAt: pinned ? new Date() : null } });
  return mapAutomation(a);
}

/** 删除(归属校验)。删到 → true。 */
export async function deleteAutomation(userId: string, id: string): Promise<boolean> {
  const r = await prisma.automation.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

/** 校验某任务归属本人(测试运行前用)。 */
export async function ownsAutomation(userId: string, id: string): Promise<boolean> {
  return (await prisma.automation.count({ where: { id, userId } })) > 0;
}
