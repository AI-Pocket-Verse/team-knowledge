import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { prisma, disconnectDb } from "../db.js";
import { resolve, join } from "node:path";
import { backupDirs, resolveDbPath, isValidBackupName, uploadsSiblingName, validateStagedDb, restoreBackup, BackupError } from "./backup.js";

describe("backupDirs", () => {
  it("备份目录在 DATA_DIR/backups/team-knowledge{,/manual} 下", () => {
    const { root, manual } = backupDirs("/var/lib/team-knowledge");
    expect(root).toBe("/var/lib/team-knowledge/backups/team-knowledge");
    expect(manual).toBe("/var/lib/team-knowledge/backups/team-knowledge/manual");
  });

  it("相对 DATA_DIR 按 cwd 解析，与 uploads 目录同源", () => {
    expect(backupDirs("./data").root).toBe(resolve("data", "backups", "team-knowledge"));
  });
});

describe("resolveDbPath", () => {
  it("相对路径以 prisma 目录为基准(与 Prisma 一致)，不是 cwd", () => {
    expect(resolveDbPath("file:./dev.db", "/repo/api/prisma")).toBe("/repo/api/prisma/dev.db");
  });
  it("绝对路径原样返回，并去掉查询参数", () => {
    expect(resolveDbPath("file:/var/lib/kb/kb.db?connection_limit=1", "/repo/api/prisma")).toBe("/var/lib/kb/kb.db");
  });
});

describe("isValidBackupName", () => {
  it("accepts the generated backup filenames", () => {
    expect(isValidBackupName("team-knowledge-2026-06-09-143005.db.gz")).toBe(true);
    expect(isValidBackupName("team-knowledge-2026-06-09-143005-prerestore.db.gz")).toBe(true);
    expect(isValidBackupName("team-knowledge-2026-06-09.db.gz")).toBe(true); // cron daily
    expect(isValidBackupName("dev-20260609-143005.db")).toBe(true); // dev snapshot
  });

  it("rejects path traversal and separators", () => {
    expect(isValidBackupName("../team-knowledge.db")).toBe(false);
    expect(isValidBackupName("..")).toBe(false);
    expect(isValidBackupName("a/../../etc/passwd")).toBe(false);
    expect(isValidBackupName("sub/team-knowledge.db.gz")).toBe(false);
    expect(isValidBackupName("foo..bar.db.gz")).toBe(false);
  });

  it("rejects non-backup extensions and empty names", () => {
    expect(isValidBackupName("team-knowledge.txt")).toBe(false);
    expect(isValidBackupName("team-knowledge.db.gz.exe")).toBe(false);
    expect(isValidBackupName("")).toBe(false);
    expect(isValidBackupName(".hidden.db")).toBe(false); // must start alnum
  });
});

describe("uploadsSiblingName", () => {
  it("db 备份名 → 同名 uploads 包名", () => {
    expect(uploadsSiblingName("team-knowledge-2026-06-09-143005.db.gz")).toBe("team-knowledge-2026-06-09-143005.uploads.tar.gz");
    expect(uploadsSiblingName("team-knowledge-2026-06-09-143005-prerestore.db.gz")).toBe("team-knowledge-2026-06-09-143005-prerestore.uploads.tar.gz");
    expect(uploadsSiblingName("dev-20260609.db")).toBe("dev-20260609.uploads.tar.gz");
  });
  it("非 db 名原样返回(不会误改)", () => {
    expect(uploadsSiblingName("something.tar.gz")).toBe("something.tar.gz");
  });
});

// 用 VACUUM INTO 从测试库拷一份「与当前代码迁移一致」的库,再按需改坏。
async function makeStagedCopy(dir: string, tweak?: (c: PrismaClient) => Promise<void>): Promise<string> {
  const out = join(dir, "staged.db");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${out}'`);
  if (tweak) {
    const c = new PrismaClient({ datasources: { db: { url: `file:${out}` } } });
    try { await tweak(c); } finally { await c.$disconnect(); }
  }
  return out;
}

describe("validateStagedDb", () => {
  afterAll(async () => { await disconnectDb(); });

  it("完好且迁移与代码一致 → 通过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-bk-"));
    try {
      await expect(validateStagedDb(await makeStagedCopy(dir))).resolves.toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("不是 SQLite 库 → backup_corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-bk-"));
    try {
      const bad = join(dir, "bad.db");
      await writeFile(bad, "this is not a sqlite database".repeat(50));
      await expect(validateStagedDb(bad)).rejects.toMatchObject({ code: "backup_corrupt" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("备份缺少代码里的迁移(备份比代码旧)→ backup_schema_outdated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-bk-"));
    try {
      const old = await makeStagedCopy(dir, async (c) => { await c.$executeRawUnsafe("DELETE FROM _prisma_migrations"); });
      await expect(validateStagedDb(old)).rejects.toMatchObject({ code: "backup_schema_outdated" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("备份里没有迁移记录表(不是本程序的库或版本过旧)→ backup_schema_outdated,而不是报损坏", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-bk-"));
    try {
      const bare = await makeStagedCopy(dir, async (c) => { await c.$executeRawUnsafe("DROP TABLE _prisma_migrations"); });
      await expect(validateStagedDb(bare)).rejects.toMatchObject({ code: "backup_schema_outdated" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("备份含代码里没有的迁移(备份比代码新)→ backup_schema_newer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-bk-"));
    try {
      const newer = await makeStagedCopy(dir, async (c) => {
        await c.$executeRawUnsafe(
          "INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('x','x','29990101000000_future', 0, 0, 1)",
        );
      });
      await expect(validateStagedDb(newer)).rejects.toMatchObject({ code: "backup_schema_newer" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("restoreBackup 互斥", () => {
  it("并发两次还原:第二次立即 restore_in_progress;结束后可再次发起(损坏备份不会换库)", async () => {
    const { manual } = backupDirs();
    await mkdir(manual, { recursive: true });
    const name = "team-knowledge-2026-01-01-000000-corrupt.db";
    await writeFile(join(manual, name), "garbage".repeat(100));
    try {
      const results = await Promise.allSettled([restoreBackup(name), restoreBackup(name)]);
      const codes = results.map((r) => (r.status === "rejected" ? (r.reason as BackupError).code : "ok")).sort();
      expect(codes).toEqual(["backup_corrupt", "restore_in_progress"]);
      await expect(restoreBackup(name)).rejects.toMatchObject({ code: "backup_corrupt" });
    } finally {
      await rm(join(manual, name), { force: true });
    }
  });
});
