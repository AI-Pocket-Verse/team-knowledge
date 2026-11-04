// 管理后台:群聊智能答疑。
// - GET  /api/admin/group-qa/stats    最近答疑记录看板(只读;管理员或该页已放开的成员)
// - GET  /api/admin/group-qa/tuning   互动节奏参数(仅管理员)
// - PUT  /api/admin/group-qa/tuning   保存互动节奏参数(仅管理员)
// 看板可放开给成员看,但「互动节奏」是全局性行为设置,只有管理员能改(同 doc-audit-tuning)。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdminOrOpenPage } from "../services/admin-visibility/index.js";
import { requireUser } from "../utils/guards.js";
import { recentStats, recentLikes } from "../services/group-qa/store.js";
import { getGroupQaTuning, setGroupQaTuning, getGroupQaLike, setGroupQaLike } from "../services/group-qa/config.js";

// 页面放开给成员后，记录里的飞书群 chat_id 与发言人 open_id(本系统的身份锚点)只给管理员看。
function redactForMember<T extends { chatId?: string; openId?: string }>(entries: T[], isAdmin: boolean): T[] {
  if (isAdmin) return entries;
  return entries.map(({ chatId: _chatId, openId: _openId, ...rest }) => rest as T);
}

export async function adminGroupQaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/group-qa/stats", async (req, reply) => {
    const user = await requireAdminOrOpenPage(req, reply, "group-qa");
    if (!user) return;
    return { entries: redactForMember(await recentStats(100), user.isAdmin) };
  });

  app.get("/api/admin/group-qa/tuning", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: "仅管理员可用" });
    return getGroupQaTuning();
  });

  app.put("/api/admin/group-qa/tuning", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: "仅管理员可用" });
    const parsed = z.object({
      cooldownSec: z.number().int().min(5).max(3600).optional(),
      hourlyCap: z.number().int().min(1).max(100).optional(),
      dedupMin: z.number().int().min(1).max(1440).optional(),
      demoteDays: z.number().int().min(1).max(90).optional(),
      answerCap: z.number().int().min(40).max(1000).optional(),
      aggressiveness: z.number().int().min(1).max(3).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const next = await setGroupQaTuning(parsed.data, user.id);
    req.log.info({ event: "group_qa.tuning_updated", ...next, by: user.id }, "group-qa tuning updated");
    return next;
  });

  // ── 群消息「AI 点赞」配置 + 看板 ──
  app.get("/api/admin/group-qa/likes", async (req, reply) => {
    const user = await requireAdminOrOpenPage(req, reply, "group-qa");
    if (!user) return;
    return { entries: redactForMember(await recentLikes(100), user.isAdmin) };
  });

  app.get("/api/admin/group-qa/like", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: "仅管理员可用" });
    return getGroupQaLike();
  });

  app.put("/api/admin/group-qa/like", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: "仅管理员可用" });
    const parsed = z.object({
      enabled: z.boolean().optional(),
      threshold: z.number().int().min(1).max(10).optional(),
      dailyCapPerGroup: z.number().int().min(1).max(50).optional(),
      cooldownMin: z.number().int().min(1).max(1440).optional(),
      userDailyCap: z.number().int().min(1).max(20).optional(),
      evalDailyBudget: z.number().int().min(10).max(5000).optional(),
      // emoji / emojiMode 用字符串收,非法值由 config 层(normalize*)回退默认。
      emoji: z.string().max(32).optional(),
      emojiMode: z.string().max(16).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const next = await setGroupQaLike(parsed.data, user.id);
    req.log.info({ event: "group_qa.like_updated", ...next, by: user.id }, "group-qa like updated");
    return next;
  });
}
