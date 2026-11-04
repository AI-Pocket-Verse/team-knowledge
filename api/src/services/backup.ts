// DB 备份 / 还原服务(管理后台,仅管理员)。
//
// 备份方式:SQLite `VACUUM INTO`(在线一致性快照,WAL 安全,无需停服)+ gzip。
// 落盘位置:<DATA_DIR>/backups/team-knowledge/。手动备份落在其 manual/ 子目录。
// 顶层目录放外部定时任务(如 cron)产出的备份,管理后台会一并列出(标记为 auto)。
//
// 还原方式:进程内热替换 —— 先给当前库拍一份 prerestore 安全快照,再短暂进入
// 维护态(isRestoring,server.ts 的 onRequest 钩子据此对其它请求返回 503),
// 断开 Prisma → 原子 rename 替换库文件 → 删除旧 WAL sidecar → 重连 → 重新置 WAL。
// 全程不引入 @team-knowledge/db-kit(buildServer 经由路由注册会把本模块拉进图,而
// db-kit 不能进 vitest 的模块图),所以用裸 PRAGMA 恢复 WAL。
import { resolve, dirname, join, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink, rename, rm, copyFile } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { BackupInfo } from "@team-knowledge/shared";
import { PrismaClient } from "@prisma/client";
import { env } from "../env.js";
import { prisma } from "../db.js";
import { L, appLang } from "../utils/lang.js";

// Prisma 把相对的 `file:` 路径按 schema 所在目录(api/prisma/)解析，而不是进程 cwd；
// 这里必须用同一规则，否则还原会写到别处。同时去掉 `?connection_limit=1` 等查询参数。
const PRISMA_DIR = fileURLToPath(new URL("../../prisma", import.meta.url));
export function resolveDbPath(databaseUrl: string, prismaDir: string = PRISMA_DIR): string {
  const raw = databaseUrl.replace(/^file:/, "").split("?")[0] ?? "";
  return isAbsolute(raw) ? raw : resolve(prismaDir, raw);
}
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");
const DB_PATH = resolveDbPath(env.DATABASE_URL);
// 上传文件本体目录(附件/图片,存磁盘、不在 DB 里)。与 server.ts 的 uploadsDir 同源。
const UPLOADS_DIR = resolve(env.DATA_DIR, "uploads");

// DB 备份名 → 配套 uploads 归档名(同目录并列)。team-knowledge-<ts>.db.gz → team-knowledge-<ts>.uploads.tar.gz。
// 导出供单测。
export function uploadsSiblingName(dbName: string): string {
  return dbName.replace(/\.db(\.gz)?$/, ".uploads.tar.gz");
}

// 跑系统 tar(打包/解包 uploads;无 tar 库)。okCodes 放行退出码:
// 打包时容忍 1(并发写导致「some files differ」,归档仍生成);解包必须 0。
function runTar(args: string[], okCodes: number[] = [0]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn("tar", args);
    let err = "";
    p.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
    p.on("error", rej);
    p.on("exit", (code) => (okCodes.includes(code ?? -1) ? res() : rej(new Error(err.trim() || `tar exited ${code}`))));
  });
}

export class BackupError extends Error {
  constructor(
    public code: "invalid_name" | "not_found" | "conflict" | "restore_in_progress" | "backup_corrupt" | "backup_schema_outdated" | "backup_schema_newer",
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

// 备份根目录 <DATA_DIR>/backups/team-knowledge/，手动子目录 .../manual/。
// 放在 DATA_DIR 下(生产必须是源码目录之外的绝对路径)，不会落进仓库。导出供单测验证路径推导。
export function backupDirs(dataDir: string = env.DATA_DIR): { root: string; manual: string } {
  const root = resolve(dataDir, "backups", "team-knowledge");
  return { root, manual: join(root, "manual") };
}

// 只接受「纯文件名」(无路径分隔符、无 .. 穿越),且为备份扩展名。导出供单测。
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isValidBackupName(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  return name.endsWith(".db.gz") || name.endsWith(".db");
}

// 文件名时间戳:2026-06-09-143005(沿用 cron 的 team-knowledge-<date> 前缀 + 时分秒)。
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0"); // 毫秒后缀,避免同秒两次备份重名互相覆盖
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

// 立即生成一份手动备份(VACUUM INTO → gzip)。prefix 用于 prerestore 安全快照。
export async function createBackup(opts: { prefix?: string } = {}): Promise<BackupInfo> {
  const { manual } = backupDirs();
  await mkdir(manual, { recursive: true });
  const ts = stamp();
  const suffix = opts.prefix ? `-${opts.prefix}` : "";
  const name = `team-knowledge-${ts}${suffix}.db.gz`;
  const finalPath = join(manual, name);
  // 隐藏前缀 + pid:listBackups 跳过以「.」开头的文件,避免半成品被列出。
  const tmpDb = join(manual, `.vacuum-${ts}-${process.pid}.db.tmp`);
  // 路径无用户输入;仍按 SQL 字面量转义单引号以防御。
  await prisma.$executeRawUnsafe(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
  try {
    await pipeline(createReadStream(tmpDb), createGzip(), createWriteStream(finalPath));
  } finally {
    await rm(tmpDb, { force: true });
  }
  const st = await stat(finalPath);

  // 配套打包 uploads 文件本体(尽力而为):失败不拖累已完成的 DB 备份 —— DB 是关键,
  // uploads 打包失败只标记 hasUploads=false(该备份还原时不还原文件)。目录不存在则跳过。
  let hasUploads = false;
  let uploadsSizeBytes: number | undefined;
  if (existsSync(UPLOADS_DIR)) {
    const upOut = join(manual, uploadsSiblingName(name));
    try {
      await runTar(["-czf", upOut, "-C", dirname(UPLOADS_DIR), basename(UPLOADS_DIR)], [0, 1]);
      uploadsSizeBytes = (await stat(upOut)).size;
      hasUploads = true;
    } catch (e) {
      await rm(upOut, { force: true }); // 清掉半成品
      // DB 备份已成功;uploads 打包失败只降级(hasUploads=false)。无注入的日志器,
      // 用 console.warn 留痕,便于排查「以为备了 uploads 其实没备」。
      console.warn(`[backup] uploads 打包失败(DB 备份已完成,本份不含附件):${(e as Error).message}`);
    }
  }
  return { name, path: finalPath, sizeBytes: st.size, createdAt: st.mtime.toISOString(), source: "manual", hasUploads, uploadsSizeBytes };
}

async function readDirBackups(dir: string, source: "manual" | "auto"): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // 目录还不存在(从未备份过)→ 空列表。
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // 跳过 .vacuum 临时文件 / .last-hash 等
    if (!(name.endsWith(".db.gz") || name.endsWith(".db"))) continue;
    const p = join(dir, name);
    let st;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // 跳过 manual/ 子目录本身
    // 配套的上传文件包(同名 .uploads.tar.gz)——列出时标注,前端显示「含附件」。
    let hasUploads = false;
    let uploadsSizeBytes: number | undefined;
    const upName = uploadsSiblingName(name);
    if (upName !== name && names.includes(upName)) {
      try { uploadsSizeBytes = (await stat(join(dir, upName))).size; hasUploads = true; } catch { /* sibling 刚被删 */ }
    }
    out.push({ name, path: p, sizeBytes: st.size, createdAt: st.mtime.toISOString(), source, hasUploads, uploadsSizeBytes });
  }
  return out;
}

// 目录下全部 team-knowledge 备份:顶层 = 每日 cron(auto),manual/ = 手动(manual)。
// 按时间倒序(最新在前)。
export async function listBackups(): Promise<BackupInfo[]> {
  const { root, manual } = backupDirs();
  const [auto, man] = await Promise.all([
    readDirBackups(root, "auto"),
    readDirBackups(manual, "manual"),
  ]);
  return [...auto, ...man].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// 在备份根目录树内解析一个备份文件(优先 manual/,再顶层),做穿越防御。
function resolveBackupFile(name: string): string | null {
  if (!isValidBackupName(name)) return null;
  const { root, manual } = backupDirs();
  for (const dir of [manual, root]) {
    const p = join(dir, name);
    // 容器校验:必须落在 manual/ 或 root/ 内(belt-and-suspenders,name 已无分隔符)。
    if (p !== resolve(p)) continue;
    if (!(p.startsWith(`${manual}/`) || p.startsWith(`${root}/`))) continue;
    return p;
  }
  return null;
}

/**
 * 换库前检查暂存库:① PRAGMA integrity_check 必须为 ok;② _prisma_migrations 里已应用的迁移
 * 与当前代码的迁移目录一致。还原不会自动跑 migrate,备份比代码旧会让新代码访问缺失的表 / 列,
 * 备份比代码新(回滚部署后还原)同理,所以两个方向都拒绝。代码侧目录读不到时跳过 ② 。
 * 用临时 Prisma 客户端只读打开暂存文件,不碰正在服务的库。
 */
export async function validateStagedDb(dbPath: string, migrationsDir: string = MIGRATIONS_DIR): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  let applied: Set<string>;
  try {
    const check = await client.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check;");
    if (check.length !== 1 || check[0]?.integrity_check !== "ok") {
      throw new BackupError("backup_corrupt", L(appLang(), "备份文件未通过完整性检查,已取消还原", "The backup failed the integrity check. Restore cancelled"));
    }
    const hasTable = await client.$queryRawUnsafe<{ n: number | bigint }[]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'",
    );
    if (Number(hasTable[0]?.n ?? 0) === 0) {
      // 库本身完好,只是没有迁移记录:不是本程序生成的库,或来自记录迁移之前的旧版本。
      throw new BackupError("backup_schema_outdated", L(appLang(), "备份里没有数据库版本记录(不是本程序的备份或版本过旧),已取消还原", "The backup has no database version record (not a backup of this app, or too old). Restore cancelled"));
    }
    const rows = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    applied = new Set(rows.map((r) => r.migration_name));
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError("backup_corrupt", L(appLang(), `备份文件无法读取(损坏或不是有效的数据库),已取消还原:${(e as Error).message}`, `The backup file cannot be read (corrupted or not a valid database). Restore cancelled: ${(e as Error).message}`));
  } finally {
    await client.$disconnect().catch(() => { /* 尽力 */ });
  }

  let codeMigrations: string[];
  try {
    codeMigrations = (await readdir(migrationsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  if (codeMigrations.some((m) => !applied.has(m))) {
    throw new BackupError("backup_schema_outdated", L(appLang(), "备份的数据库结构比当前版本旧,直接还原会导致站点报错,已取消还原", "The backup's database schema is older than the current version and restoring it would break the site. Restore cancelled"));
  }
  if ([...applied].some((m) => !codeMigrations.includes(m))) {
    throw new BackupError("backup_schema_newer", L(appLang(), "备份的数据库结构比当前版本新,请先部署对应版本再还原,已取消还原", "The backup's database schema is newer than the current version. Deploy the matching version first. Restore cancelled"));
  }
}

// ── 维护态:还原热替换库文件时,server.ts 据此对其它请求短暂返回 503 ──────
let restoring = false;
export function isRestoring(): boolean {
  return restoring;
}

// 进程内互斥:同一时刻只允许一次还原(两次共用同一个暂存文件,并发会写坏)。
// 与 restoring 分开:restoring 会让全站 503,只在最后的换库窗口才能置位。
let restoreInFlight = false;

// 还原到所选备份。进程内热替换;返回 prerestore 安全快照 + 是否一并还原了 uploads。
export async function restoreBackup(name: string): Promise<{ predo: BackupInfo; uploadsRestored: boolean }> {
  if (restoreInFlight) throw new BackupError("restore_in_progress", L(appLang(), "已有一次还原正在进行,请稍后再试", "A restore is already in progress. Please try again later"));
  restoreInFlight = true;
  try {
    return await doRestore(name);
  } finally {
    restoreInFlight = false;
  }
}

async function doRestore(name: string): Promise<{ predo: BackupInfo; uploadsRestored: boolean }> {
  const src = resolveBackupFile(name);
  if (!src) throw new BackupError("invalid_name", L(appLang(), "非法的备份文件名", "Invalid backup file name"));
  try {
    const st = await stat(src);
    if (!st.isFile()) throw new BackupError("not_found", L(appLang(), "备份文件不存在", "Backup file not found"));
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("not_found", L(appLang(), "备份文件不存在", "Backup file not found"));
  }

  // 1) 把待还原库解到暂存文件(纯 fs,不需要 DB),并在换库前校验。校验放在 prerestore
  // 快照之前:坏备份反复尝试不会把有用的 prerestore 快照挤掉。
  const staging = `${DB_PATH}.restoring`;
  try {
    if (src.endsWith(".gz")) {
      await pipeline(createReadStream(src), createGunzip(), createWriteStream(staging));
    } else {
      await copyFile(src, staging);
    }
    await validateStagedDb(staging);
  } catch (e) {
    await rm(staging, { force: true });
    if (e instanceof BackupError) throw e;
    throw new BackupError("backup_corrupt", L(appLang(), `备份文件无法解压,已取消还原:${(e as Error).message}`, `The backup file cannot be extracted. Restore cancelled: ${(e as Error).message}`));
  }

  // 2) 还原前安全快照(此时仍连接,VACUUM INTO 在线可用)。
  let predo: BackupInfo;
  try {
    predo = await createBackup({ prefix: "prerestore" });
  } catch (e) {
    await rm(staging, { force: true });
    throw e;
  }
  await prunePrerestore(); // 限量保留,避免 prerestore 快照在 manual/ 无限堆积

  // 2b) 若该备份带配套 uploads 包,把它解到暂存目录(风险 I/O 放在维护窗口【之前】,
  // 失败就清理暂存并抛错——此时 DB 尚未替换,整次还原干净失败、无副作用)。窗口内只做
  // 快速原子 rename。没有配套包(旧备份 / 备份时无 uploads)→ 不动现有 uploads。
  // 先清理上次还原崩溃可能残留的 uploads 临时目录(.old-* / .restore-staging),
  // 避免 GB 级孤儿目录无限堆积(它们只在还原过程中产生,正常结束会删)。
  await sweepUploadsTemp();
  const upArchive = join(dirname(src), uploadsSiblingName(basename(src)));
  const upStagingParent = `${UPLOADS_DIR}.restore-staging`;
  let stagedUploads: string | null = null;
  if (existsSync(upArchive)) {
    try {
      await rm(upStagingParent, { recursive: true, force: true });
      await mkdir(upStagingParent, { recursive: true });
      // 穿越防御(不用 --no-absolute-names:GNU-only,bsdtar 会报错破坏可移植性):
      //   ① GNU/bsd tar 默认都会剥离成员名里的前导「/」与「..」;
      //   ② 更关键——解到独立 staging 后,下面只 rename 其中的【uploads 子目录】进位,
      //      任何写到 staging 之外的穿越成员都进不了 UPLOADS_DIR;
      //   ③ 归档来源受限于备份目录(与 .db.gz 同一信任边界,restore 前已 resolveBackupFile 校验)。
      await runTar(["-xzf", upArchive, "-C", upStagingParent]); // → upStagingParent/uploads/…
      const staged = join(upStagingParent, basename(UPLOADS_DIR));
      if (existsSync(staged)) stagedUploads = staged;
      else await rm(upStagingParent, { recursive: true, force: true }); // 归档异常,放弃 uploads
    } catch (e) {
      await rm(staging, { force: true });
      await rm(upStagingParent, { recursive: true, force: true });
      throw new BackupError("conflict", L(appLang(), `上传文件包解压失败,已取消还原:${(e as Error).message}`, `Failed to extract the uploads package. Restore cancelled: ${(e as Error).message}`));
    }
  }

  // 3) 维护窗口:断开连接 → 原子替换库 → 清旧 WAL → 重连 → 恢复 WAL →(有则)换 uploads。
  restoring = true;
  let uploadsRestored = false;
  try {
    await new Promise((r) => setTimeout(r, 150)); // 让在途查询排空
    await prisma.$disconnect();
    await rename(staging, DB_PATH); // 同盘原子替换
    await rm(`${DB_PATH}-wal`, { force: true });
    await rm(`${DB_PATH}-shm`, { force: true });
    await prisma.$connect();
    // VACUUM INTO 产物为 rollback 模式,重新置回 WAL(与 db-kit enableWal 一致)。
    // 这些 PRAGMA 会返回结果行,必须用 $queryRawUnsafe —— $executeRawUnsafe 在
    // SQLite 上遇到返回行会抛 "Execute returned results"(会让还原误报失败)。
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
    await prisma.$queryRawUnsafe("PRAGMA foreign_keys=ON;");
    // uploads 目录整体替换(纯快速 rename,同盘原子):现有的挪到 .old,已解好的换上,再删旧。
    // 整段包一层 try/catch【绝不抛出】:此刻 DB 已成功换好,任何 uploads 异常(如
    // uploads 是独立挂载点导致 rename 跨盘 EXDEV)都不能把「已还原成功」翻成失败——
    // 只让 uploadsRestored=false 如实反映,残留临时目录留待下次还原开头 sweep 清理。
    if (stagedUploads) {
      try {
        const old = `${UPLOADS_DIR}.old-${stamp()}`;
        const hadUploads = existsSync(UPLOADS_DIR);
        if (hadUploads) await rename(UPLOADS_DIR, old);
        try {
          await rename(stagedUploads, UPLOADS_DIR);
          uploadsRestored = true;
        } catch {
          // 换上失败:回滚——把刚挪走的旧 uploads 挪回原位,避免目录「凭空消失」。
          if (hadUploads && !existsSync(UPLOADS_DIR)) await rename(old, UPLOADS_DIR).catch(() => { /* 尽力 */ });
        }
        await rm(upStagingParent, { recursive: true, force: true });
        if (uploadsRestored) await rm(old, { recursive: true, force: true }); // 换成功才删旧
      } catch {
        uploadsRestored = false; // DB 已还原,uploads 未换——不抛,如实返回
      }
    }
  } finally {
    restoring = false;
  }
  return { predo, uploadsRestored };
}

// prerestore 安全快照只保留最近若干份(cron 的 -maxdepth 1 不清 manual/,否则会
// 随每次还原无限堆积)。
const PRERESTORE_KEEP = 10;
async function prunePrerestore(): Promise<void> {
  const { manual } = backupDirs();
  let names: string[];
  try {
    names = await readdir(manual);
  } catch {
    return;
  }
  const files = names.filter((n) => n.endsWith("-prerestore.db.gz"));
  if (files.length <= PRERESTORE_KEEP) return;
  const withMtime: Array<{ p: string; m: number }> = [];
  for (const n of files) {
    try {
      const st = await stat(join(manual, n));
      withMtime.push({ p: join(manual, n), m: st.mtimeMs });
    } catch { /* skip */ }
  }
  withMtime.sort((a, b) => b.m - a.m);
  for (const { p } of withMtime.slice(PRERESTORE_KEEP)) {
    await rm(p, { force: true });
  }
}

// 清理上次还原崩溃可能残留的 uploads 临时目录(.old-<stamp> / .restore-staging)。
// 它们只在还原过程中产生、正常结束会删;进程若在两次 rename 之间崩溃则会残留 GB 级
// 孤儿目录,且无别的 pruner 清扫它——故每次还原开头扫一遍兜底。绝不抛。
async function sweepUploadsTemp(): Promise<void> {
  const parent = dirname(UPLOADS_DIR);
  const base = basename(UPLOADS_DIR);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(`${base}.old-`) || n === `${base}.restore-staging`) {
      await rm(join(parent, n), { recursive: true, force: true }).catch(() => { /* 尽力 */ });
    }
  }
}

// 删除一份备份(后台手动管理;同样做穿越防御)。
export async function deleteBackup(name: string): Promise<void> {
  const p = resolveBackupFile(name);
  if (!p) throw new BackupError("invalid_name", L(appLang(), "非法的备份文件名", "Invalid backup file name"));
  try {
    const st = await stat(p);
    if (!st.isFile()) throw new BackupError("not_found", L(appLang(), "备份文件不存在", "Backup file not found"));
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("not_found", L(appLang(), "备份文件不存在", "Backup file not found"));
  }
  await unlink(p);
  // 一并删掉配套的 uploads 包(同目录同名);不存在则忽略。
  await rm(join(dirname(p), uploadsSiblingName(basename(p))), { force: true });
}
