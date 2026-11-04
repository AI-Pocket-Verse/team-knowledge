// 管理后台:让管理员经助手给某用户发一条(生成式)飞书通知。既是三期能力的
// 参考调用方,也是真机测试入口。真正的「后台任务」调用方(周报/提醒/审批结果等)
// 直接 import notifyUserVia助手即可,不必经 HTTP。
import { L } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../utils/guards.js";
import { notifyUserViaAssistant } from "../services/notify/assistantNotify.js";

const bodySchema = z.object({
  userId: z.string().min(1),
  intent: z.string().min(1).max(2000),
  context: z.string().max(8000).optional(),
  conversational: z.boolean().optional(),
  link: z.object({ text: z.string().min(1).max(40), url: z.string().url() }).optional(),
});

export async function adminAssistantNotifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/assistant-notify", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    return notifyUserViaAssistant({ ...parsed.data, log: req.log });
  });
}
