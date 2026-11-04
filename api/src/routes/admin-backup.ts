// 管理后台:DB 备份 / 还原(仅管理员)。
//   GET    /api/admin/backup              列出目录下全部 team-knowledge 备份
//   POST   /api/admin/backup              立即手动备份
//   POST   /api/admin/backup/:name/restore 还原到所选备份(进程内热替换)
//   DELETE /api/admin/backup/:name        删除一份备份
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../utils/guards.js";
import {
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  BackupError,
} from "../services/backup.js";

export async function adminBackupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/backup", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const backups = await listBackups();
    return { backups };
  });

  app.post("/api/admin/backup", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    try {
      const backup = await createBackup();
      return { backup };
    } catch (err) {
      req.log.error({ err }, "manual backup failed");
      return reply.code(500).send({ error: "backup_failed", message: `备份失败：${(err as Error).message}` });
    }
  });

  app.post("/api/admin/backup/:name/restore", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const { name } = req.params as { name: string };
    try {
      const { predo, uploadsRestored } = await restoreBackup(name);
      return { ok: true as const, predo, uploadsRestored };
    } catch (err) {
      if (err instanceof BackupError) {
        // 备份本身不可用(损坏 / 迁移版本不符)用 422;已有还原在跑 / 其它冲突用 409。
        const code = err.code === "not_found" ? 404
          : err.code === "invalid_name" ? 400
          : err.code === "backup_corrupt" || err.code === "backup_schema_outdated" || err.code === "backup_schema_newer" ? 422
          : 409;
        return reply.code(code).send({ error: err.code, message: err.message });
      }
      req.log.error({ err }, "restore failed");
      return reply.code(500).send({ error: "restore_failed", message: `还原失败：${(err as Error).message}` });
    }
  });

  app.delete("/api/admin/backup/:name", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const { name } = req.params as { name: string };
    try {
      await deleteBackup(name);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof BackupError) {
        return reply.code(err.code === "not_found" ? 404 : 400).send({ error: err.code, message: err.message });
      }
      req.log.error({ err }, "delete backup failed");
      return reply.code(500).send({ error: "delete_failed", message: `删除失败：${(err as Error).message}` });
    }
  });
}
