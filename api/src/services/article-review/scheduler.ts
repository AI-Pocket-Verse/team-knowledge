// article-review 进程内定时扫描器。挑「静置满阈值 + 自上次 review 后有改动 + 无活动编辑锁
// + 未被内容过滤排除 + 有可检索内容 + 内容 hash 已变」的文档逐篇校验。扫描间隔与静置阈值
// 由管理后台配置(见 config.ts);跨列比较(reviewedAt < updatedAt)+ hash 在 JS 里做,
// 避免 SQLite datetime 跨列比较的坑。
import type { FastifyBaseLogger } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { hasRetrievableContent } from "../../utils/retrievable.js";
import { isRestoring } from "../backup.js";
import { getAssistantExclusionSets, exclusionSqlFilter } from "../assistant-filter/exclusions.js";
import { getReviewEnabled, getIdleMinutes, getScanIntervalSec, IDLE_DEFAULT_MIN, SCAN_INTERVAL_DEFAULT_SEC } from "./config.js";
import { contentHash, reviewArticle } from "./review.js";

const LOCK_TTL_MS = 45_000;       // 与 routes/articles.ts 的软编辑锁一致
const SCAN_LIMIT = 200;           // 每批取多少行做 JS 二次过滤
const MAX_BATCHES = 20;           // 每轮最多取几批(防异常数据下长时间扫库)
const MAX_PER_TICK = 5;           // 每轮最多实际跑几篇 LLM
const DEFAULT_IDLE_MS = IDLE_DEFAULT_MIN * 60_000;

export interface ReviewCandidate { id: string; title: string; contentMarkdown: string; }

/** 选出本轮候选。把「需复检」谓词下推到 DB,让 LIMIT 返回真候选 —— 否则
 *  「按 updatedAt 升序取前 N」会被一堆已检旧文档塞满窗口,新编辑的文档(updatedAt 最新)
 *  永远进不来而饿死。updatedAt/editingAt/reviewedAt 在 SQLite 存为 epoch-ms 整数,
 *  绑定数字精确比较;reviewedAt < updatedAt 是跨列比较,无需绑定日期。
 *  idleMs:静置阈值(毫秒),由调用方按后台配置传入;默认 10 分钟。 */
export async function selectReviewCandidates(now: Date, idleMs: number = DEFAULT_IDLE_MS): Promise<ReviewCandidate[]> {
  const exclusionFilter = exclusionSqlFilter(await getAssistantExclusionSets());
  const idleCutoffMs = now.getTime() - idleMs;
  const lockCutoffMs = now.getTime() - LOCK_TTL_MS;

  // 过短 / hash 未变的行 SQL 筛不掉,若只取一批,前 SCAN_LIMIT 篇「永远筛不掉」的行会把后面的真候选
  // 挤出窗口(饿死)。两层处理:① 按 (updatedAt,id) 游标分批继续取,直到凑够或取完(最多 MAX_BATCHES 批);
  // ② 被跳过的行把 reviewedAt 对齐到所见的 updatedAt(与 routes/articles.ts apply 同法,raw 不 bump updatedAt),
  // 让它们落出 SQL 谓词,下一轮不再占窗口;之后任何编辑 bump updatedAt 都会重新成为候选。
  const out: ReviewCandidate[] = [];
  const skipped: Array<{ id: string; at: number }> = [];
  type Cursor = { at: number; id: string };
  let cursor = null as Cursor | null;
  for (let batch = 0; batch < MAX_BATCHES && out.length < MAX_PER_TICK; batch++) {
    const after: Prisma.Sql = cursor
      ? Prisma.sql`AND (a.updatedAt > ${cursor.at} OR (a.updatedAt = ${cursor.at} AND a.id > ${cursor.id}))`
      : Prisma.empty;
    const rows: Array<{ id: string; title: string; contentMarkdown: string; reviewedHash: string | null; updatedAt: bigint | number }> = await prisma.$queryRaw<Array<{ id: string; title: string; contentMarkdown: string; reviewedHash: string | null; updatedAt: bigint | number }>>(Prisma.sql`
      SELECT a.id AS id, a.title AS title, a.contentMarkdown AS contentMarkdown, a.reviewedHash AS reviewedHash, a.updatedAt AS updatedAt
        FROM "Article" a
       WHERE a.deletedAt IS NULL
         AND a.updatedAt <= ${idleCutoffMs}
         AND (a.reviewedAt IS NULL OR a.reviewedAt < a.updatedAt)
         AND NOT (a.editingById IS NOT NULL AND a.editingAt IS NOT NULL AND a.editingAt >= ${lockCutoffMs})
         ${after}
         ${exclusionFilter}
       ORDER BY a.updatedAt ASC, a.id ASC
       LIMIT ${SCAN_LIMIT}
    `);
    for (const a of rows) {
      cursor = { at: Number(a.updatedAt), id: a.id };
      if (!hasRetrievableContent(a.contentMarkdown)) { skipped.push({ id: a.id, at: cursor.at }); continue; }   // 空/过短
      // 内容相对上次校验未变(no-op 保存等)→ 跳过;只要内容有任何改动(哪怕一个字)就复检。
      // 一键优化即把 reviewedHash 对齐到优化后内容(见 routes/articles.ts apply),故优化本身
      // 不会触发复检,但其后任意编辑都会。
      if (a.reviewedHash != null && a.reviewedHash === contentHash(a.title, a.contentMarkdown)) { skipped.push({ id: a.id, at: cursor.at }); continue; }
      out.push({ id: a.id, title: a.title, contentMarkdown: a.contentMarkdown });
      if (out.length >= MAX_PER_TICK) break;
    }
    if (rows.length < SCAN_LIMIT) break;
  }
  // 带 updatedAt 相等条件:扫描后若该行恰被编辑(updatedAt 已变),不覆盖,保证新编辑仍会被复检。
  for (let i = 0; i < skipped.length; i += 100) {
    await prisma.$transaction(skipped.slice(i, i + 100).map((r) =>
      prisma.$executeRaw`UPDATE "Article" SET "reviewedAt" = ${r.at} WHERE "id" = ${r.id} AND "updatedAt" = ${r.at}`));
  }
  return out;
}

// 重入保护:一轮最多 MAX_PER_TICK 篇 × 每篇 LLM ≤180s,可能远超 2 分钟间隔。上一轮
// 未结束就跑下一轮会重选同一篇(它尚未 persistReview)→ 同篇并发 LLM + 重复通知。
// 与 utils/notify/dispatcher.ts 的 `running` 闸同理(单进程,足够)。
let ticking = false;

/** 跑一轮(重入 / 开关关 / 还原中 / 无候选都安全 no-op)。导出供测试与手动触发。 */
export async function runReviewTick(log?: FastifyBaseLogger): Promise<number> {
  if (ticking || isRestoring()) return 0;
  if (!(await getReviewEnabled())) return 0;
  ticking = true;
  try {
    const idleMs = (await getIdleMinutes()) * 60_000;
    const candidates = await selectReviewCandidates(new Date(), idleMs);
    let done = 0;
    for (const c of candidates) {
      try {
        await reviewArticle(c.id, { notify: true });
        done++;
      } catch (err) {
        log?.error({ err, articleId: c.id }, "article-review tick: 单篇校验失败");
      }
    }
    if (done > 0) log?.info({ done }, "article-review tick done");
    return done;
  } finally {
    ticking = false;
  }
}

// 用「自重排 setTimeout」而非固定 setInterval:每个周期都按后台最新的 scanIntervalSec 排下一次,
// 所以扫描间隔改了下个周期就生效,无需重启;读配置失败则回退默认,不中断循环。
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function scheduleNext(log?: FastifyBaseLogger): Promise<void> {
  if (!started) return;
  let sec = SCAN_INTERVAL_DEFAULT_SEC;
  try {
    sec = await getScanIntervalSec();
  } catch (err) {
    log?.warn({ err: (err as Error).message }, "article-review: 读取扫描间隔失败,用默认值");
  }
  if (!started) return;
  timer = setTimeout(() => {
    void runReviewTick(log)
      .catch((err) => log?.warn({ err: (err as Error).message }, "article-review tick threw"))
      .finally(() => void scheduleNext(log));
  }, sec * 1000);
  timer.unref?.();
}

/** 启动调度(真实服务进程,index.ts 调用)。返回停止函数。 */
export function startArticleReviewScheduler(log?: FastifyBaseLogger): () => void {
  if (started) return () => {};
  started = true;
  void scheduleNext(log);
  return () => {
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
