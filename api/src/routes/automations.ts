// 自动化(定时 AI 任务)API。全部 requireUser + 归属个人;写操作经 service 做归属校验与调度重算。
import { L } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../utils/guards.js";
import {
  listAutomations, listRuns, listRunsForAutomation, getAutomation, getRunDetail, createAutomation, updateAutomation,
  setAutomationEnabled, setAutomationPinned, deleteAutomation, ownsAutomation, isInputError, RUNS_PAGE_SIZE,
  type AutomationInput,
} from "../services/automation/service.js";
import { runAutomation, isAutomationRunning } from "../services/automation/run.js";
import { AUTOMATION_TEMPLATES } from "../services/automation/templates.js";

const inputSchema = z.object({
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(8000),
  webhookUrl: z.string().max(500).nullish(),
  scheduleKind: z.enum(["cron", "interval", "once"]),
  scheduleConfig: z.record(z.string(), z.unknown()),
  effectiveFrom: z.number().int().nullish(),
  effectiveTo: z.number().int().nullish(),
});

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  // 列表:本人任务 + 近期运行 + 内置模板(一次拉齐,前端渲染列表/模板库)。
  app.get("/api/automations", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { automations, recentRuns, runsHasMore } = await listAutomations(user.id);
    return { automations, recentRuns, runsHasMore, templates: AUTOMATION_TEMPLATES };
  });

  // 运行记录分页(「已完成」加载更多):每页 10 条,cursor=上一页最后一条 id。放在 /:id 之前。
  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/api/automations/runs", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || RUNS_PAGE_SIZE));
    return listRuns(user.id, req.query.cursor || undefined, limit);
  });

  // 运行详情(只读阅读页):完整产出 + 已转好的可读 markdown。放在 /:id 之前,避免 "runs" 被当作 id。
  app.get<{ Params: { id: string } }>("/api/automations/runs/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const detail = await getRunDetail(user.id, req.params.id);
    if (!detail) return reply.code(404).send({ error: "not_found", message: L(req, "运行记录不存在", "Run record not found") });
    return detail;
  });

  // 单个任务的运行记录分页(「已完成」每个任务折叠展开 / 加载更多)。放在 /:id 之前。
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>("/api/automations/:id/runs", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const page = await listRunsForAutomation(user.id, req.params.id, req.query.cursor || undefined, limit);
    if (!page) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
    return page;
  });

  app.get<{ Params: { id: string } }>("/api/automations/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const a = await getAutomation(user.id, req.params.id);
    if (!a) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
    return a;
  });

  app.post("/api/automations", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数不合法", "Invalid parameters") });
    try {
      return await createAutomation(user.id, parsed.data as AutomationInput);
    } catch (e) {
      if (isInputError(e)) return reply.code(400).send({ error: "invalid_input", message: e.message });
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/automations/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数不合法", "Invalid parameters") });
    try {
      const a = await updateAutomation(user.id, req.params.id, parsed.data as AutomationInput);
      if (!a) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
      return a;
    } catch (e) {
      if (isInputError(e)) return reply.code(400).send({ error: "invalid_input", message: e.message });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/automations/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ok = await deleteAutomation(user.id, req.params.id);
    if (!ok) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
    return { ok: true };
  });

  // 暂停 / 恢复:enabled 开关 + 重算(恢复时)/清空(暂停时)nextRunAt。
  for (const [path, enabled] of [["pause", false], ["resume", true]] as const) {
    app.post<{ Params: { id: string } }>(`/api/automations/:id/${path}`, async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const a = await setAutomationEnabled(user.id, req.params.id, enabled);
      if (!a) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
      return a;
    });
  }

  // 置顶 / 取消置顶(「已完成」分组浮到最前)。
  app.post<{ Params: { id: string } }>("/api/automations/:id/pin", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: L(req, "参数不合法", "Invalid parameters") });
    const a = await setAutomationPinned(user.id, req.params.id, parsed.data.pinned);
    if (!a) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
    return a;
  });

  // 测试运行:立即跑一次(isTest=true,不动调度)。执行较慢(LLM),故【异步触发】立即返回;
  // 前端稍后重拉列表即可在「已完成」看到这条运行记录。
  app.post<{ Params: { id: string } }>("/api/automations/:id/run", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!(await ownsAutomation(user.id, req.params.id))) return reply.code(404).send({ error: "not_found", message: L(req, "任务不存在", "Job not found") });
    if (isAutomationRunning(req.params.id)) return reply.code(202).send({ started: false, alreadyRunning: true });
    void runAutomation(req.params.id, { isTest: true, log: req.log }).catch((e) => req.log.error({ err: e }, "[automation] test run failed"));
    return reply.code(202).send({ started: true });
  });
}
