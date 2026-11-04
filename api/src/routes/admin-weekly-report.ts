// 管理后台:知识库周报(仅管理员)。
//   GET  /api/admin/weekly-report           周报列表(按周倒序)
//   GET  /api/admin/weekly-report/:id        单份周报全量快照
//   POST /api/admin/weekly-report/generate   生成 / 刷新本周周报
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../utils/guards.js";
import { requireAdminOrOpenPage } from "../services/admin-visibility/index.js";
import { listWeeklyReports, getWeeklyReport, generateCurrentWeek } from "../services/weekly-report.js";

export async function adminWeeklyReportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/weekly-report", async (req, reply) => {
    const admin = await requireAdminOrOpenPage(req, reply, "weekly-report");
    if (!admin) return;
    return { reports: await listWeeklyReports() };
  });

  app.get("/api/admin/weekly-report/:id", async (req, reply) => {
    const admin = await requireAdminOrOpenPage(req, reply, "weekly-report");
    if (!admin) return;
    const { id } = req.params as { id: string };
    const r = await getWeeklyReport(id);
    if (!r) return reply.code(404).send({ error: "not_found", message: "周报不存在" });
    return r;
  });

  app.post("/api/admin/weekly-report/generate", async (req, reply) => {
    // 页面放开给成员后也只读：生成会全表扫描并覆盖本周快照，只留给管理员。
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    // 生成 / 刷新「本周(进行中)」周报(regenerate=true 覆盖重算实时快照)。
    // 上一个完整周由每周一 00:00 定时任务自动定稿归档,不走这里。
    try {
      const r = await generateCurrentWeek(new Date(), { regenerate: true });
      return { id: r.id, weekKey: r.weekKey, created: r.created };
    } catch (err) {
      req.log.error({ err }, "manual weekly report generation failed");
      return reply.code(500).send({ error: "generate_failed", message: `生成失败：${(err as Error).message}` });
    }
  });
}
