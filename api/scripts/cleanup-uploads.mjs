#!/usr/bin/env node
// 手动清理无人引用的上传文件(服务进程内每天也会自动清一次)。需要 tsx 加载 .ts 源码，
// 请用 package.json 里的命令运行：
//   pnpm --filter @team-knowledge/api cleanup-uploads:prod -- --dry-run
//
// Flags:
//   --dry-run            : report what would be deleted, don't touch anything
//   --older-than-days=N  : override the default 7-day grace window
//
// Exits 0 on success, 1 on cleanup error.
import { cleanupOrphanUploads } from "../src/utils/uploadCleanup.js";
import { disconnectDb } from "../src/db.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const ageFlag = argv.find((a) => a.startsWith("--older-than-days="));
const olderThanDays = ageFlag ? Number(ageFlag.split("=")[1]) : 7;
if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
  console.error(`[cleanup-uploads] --older-than-days 需要是不小于 0 的数字，收到：${ageFlag}`);
  process.exit(2);
}
const olderThanMs = olderThanDays * 24 * 60 * 60 * 1000;

try {
  const result = await cleanupOrphanUploads({ olderThanMs, dryRun });
  const verb = dryRun ? "[dry-run] would remove" : "removed";
  console.log(
    `[cleanup-uploads] ${verb} ${result.deletedRows} orphan row(s) and ` +
    `${result.deletedFiles} file(s); scanned ${result.scannedFiles} disk entries ` +
    `(age threshold ${olderThanDays}d).`,
  );
  process.exit(0);
} catch (err) {
  console.error("[cleanup-uploads] failed:", err);
  process.exit(1);
} finally {
  await disconnectDb().catch(() => {});
}
