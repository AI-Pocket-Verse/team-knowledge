// 内部接口(仅 feishu-sso 飞书卡片回调调用,x-internal-token 鉴权):点击「确认」一条
// 体检问题 → 落「已确认」+ 回传重建后的卡片,feishu-sso 侧据此 PATCH 更新消息 + 弹 toast。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { internalTokenOk } from "../utils/internalToken.js";
import { acknowledgeFinding } from "../services/doc-audit/acknowledge.js";

const bodySchema = z.object({
  hash: z.string().min(1).max(64),
  operatorOpenId: z.string().optional().default(""),
  // 勾选器方向:true=勾(确认),false=取消勾(撤销确认)。缺省按勾处理(兼容旧调用)。
  checked: z.boolean().optional().default(true),
});

export async function internalDocAuditRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/internal/doc-audit/acknowledge", async (req, reply) => {
    if (!internalTokenOk(req.headers["x-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const r = await acknowledgeFinding(parsed.data.hash, parsed.data.operatorOpenId || "unknown", parsed.data.checked);
    return { toast: r.toast, card: r.card };
  });
}
