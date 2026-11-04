// 管理后台:飞书群通知控制台。列出所有群聊通知任务,管理员可勾选目标群(多选)、
// 开/关自动任务,或手动触发真实发送以验证卡片样式 + 出站链路。仅管理员。
// - GET   /api/admin/notify-test/scenarios        列出任务 + 各自配置(可选群/已选群/开关)
// - PATCH /api/admin/notify-test/scenarios/:key   更新配置 { enabled?, chatIds? }
// - POST  /api/admin/notify-test/send             手动触发(异步)→ 202 { jobId }
// - GET   /api/admin/notify-test/send/:jobId      查询发送结果(前端轮询)
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../utils/guards.js";
import { listScenarios, scenarioMetaByKey, startSendJob, getSendJob, AlreadyRunningError } from "../services/notify-test/index.js";
import { SCENARIO_KEYS, type ScenarioKey, getScenarioNotifyConfig, setScenarioNotifyConfig } from "../services/notify-config/index.js";
import { rescheduleNotifyCron } from "../services/notify-cron/index.js";

const sendSchema = z.object({ key: z.string().min(1).max(64) });
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  chatIds: z.array(z.string().startsWith("oc_")).max(50).optional(),
  // 定时类任务的触发时刻(北京时间):星期多选 + 时:分 + 是否每周重复。
  schedule: z.object({
    weekdays: z.array(z.number().int().min(1).max(7)).min(1, "至少选择一个星期").max(7),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    repeat: z.boolean(),
  }).optional(),
}).refine((v) => v.enabled !== undefined || v.chatIds !== undefined || v.schedule !== undefined, {
  message: "至少提供 enabled / chatIds / schedule 之一",
});

export async function adminNotifyTestRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/notify-test/scenarios", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    return { scenarios: await listScenarios() };
  });

  // 更新单个任务的配置(目标群多选 / 自动任务开关),立即生效:
  // 事件触发器与 cron 脚本发送前都会读这份配置。
  app.patch<{ Params: { key: string } }>("/api/admin/notify-test/scenarios/:key", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const key = req.params.key as ScenarioKey;
    if (!SCENARIO_KEYS.includes(key)) {
      return reply.code(404).send({ error: "not_found", message: `未知的通知任务:${req.params.key}` });
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    try {
      await setScenarioNotifyConfig(key, parsed.data, user.id);
      // 触发时刻改了 → 调度器立即按新配置重排下一次(非定时场景为 no-op)。
      if (parsed.data.schedule) rescheduleNotifyCron(key);
      // 回最新完整场景(含按新配置生成的 schedule 文案 / cronSchedule / running)。
      const scenario = (await listScenarios()).find((s) => s.key === key)!;
      return { scenario };
    } catch (e) {
      return reply.code(400).send({ error: "invalid_input", message: (e as Error).message });
    }
  });

  // 手动发送(异步):同步只做轻校验(任务存在 + 已勾选目标群),重活(组卡片可能
  // 跑 LLM 2-3 分钟)放后台任务,立即 202 返回 jobId,前端轮询拿结果 —— 避免长
  // HTTP 请求撞上网关/代理超时。
  app.post("/api/admin/notify-test/send", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const meta = scenarioMetaByKey(parsed.data.key);
    if (!meta) return reply.code(400).send({ error: "invalid_input", message: `未知的通知场景:${parsed.data.key}` });
    const cfg = await getScenarioNotifyConfig(meta.key);
    if (cfg.chatIds.length === 0) {
      return reply.code(400).send({ error: "no_target", message: `「${meta.title}」未勾选目标群聊,请先在下方勾选至少一个群。` });
    }
    try {
      const job = startSendJob(meta.key);
      reply.code(202);
      return { jobId: job.id };
    } catch (e) {
      // 该场景正在执行(定时触发 / 另一位管理员的发送测试)→ 409,前端原样提示。
      if (e instanceof AlreadyRunningError) {
        return reply.code(409).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });

  // 查询发送任务结果(前端 1.5s 间隔轮询)。
  app.get<{ Params: { jobId: string } }>("/api/admin/notify-test/send/:jobId", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const job = getSendJob(req.params.jobId);
    if (!job) return reply.code(404).send({ error: "not_found", message: "任务不存在或已过期" });
    return { status: job.status, ok: job.ok, results: job.results, error: job.error };
  });
}
