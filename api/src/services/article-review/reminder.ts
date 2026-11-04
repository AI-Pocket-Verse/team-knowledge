// 每日复检提醒:仍处于「有问题(reviewStatus=issues)」的文档,按后台配置的工作日 + 时间,
// 给「最后编辑者」发一条聚合飞书提醒(每人每天一条),直到问题被修复或忽略。
// 复用现有出站通道:写 Notification 行(type=article_review_reminder)→ kickDispatch → 飞书卡片。
// 调度:每 60s 一跳,读最新配置(改了即时生效);命中「配置星期 + [HH:MM, HH:MM+10min) 窗口」
// 且今日未发过就发一次(内存态 + DB dedupeKey 双保险)。
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../db.js";
import { isRestoring } from "../backup.js";
import { kickDispatch } from "../../utils/notify/dispatcher.js";
import { trackBestEffort } from "../../utils/guards.js";
import { getReminderEnabled, getReminderSettings } from "./config.js";
import { resolveLastEditorId } from "./notify.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";
import { L, appLang } from "../../utils/lang.js";

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const WINDOW_MIN = 10; // 命中窗口:[目标时刻, +10min),容忍进程延迟/重启
const pad = (n: number) => String(n).padStart(2, "0");

function beijingParts(nowMs: number): { dow: number; minutes: number; dateStr: string } {
  const b = new Date(nowMs + BEIJING_OFFSET_MS);
  const dow0 = b.getUTCDay(); // 0=周日
  return {
    dow: dow0 === 0 ? 7 : dow0, // 1=周一..7=周日
    minutes: b.getUTCHours() * 60 + b.getUTCMinutes(),
    dateStr: `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`,
  };
}

function findingsCount(json: string | null): number {
  if (!json) return 0;
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.length : 0; } catch { return 0; }
}

/** 扫描仍有问题的文档 → 按最后编辑者聚合 → 每人一条飞书提醒(当天 dedupe)。返回发出的条数。 */
export async function sendReviewReminders(dateStr: string, log?: FastifyBaseLogger): Promise<number> {
  const arts = await prisma.article.findMany({
    where: { deletedAt: null, reviewStatus: "issues" },
    select: { id: true, title: true, reviewFindings: true },
    orderBy: { reviewedAt: "desc" },
  });
  if (arts.length === 0) return 0;

  // recipientId → 该人名下待优化文档列表
  const byRecipient = new Map<string, { id: string; title: string; count: number }[]>();
  for (const a of arts) {
    const recipientId = await resolveLastEditorId(a.id);
    if (!recipientId) continue;
    const list = byRecipient.get(recipientId) ?? [];
    list.push({ id: a.id, title: a.title, count: findingsCount(a.reviewFindings) });
    byRecipient.set(recipientId, list);
  }

  let sent = 0;
  for (const [recipientId, docs] of byRecipient) {
    const dedupeKey = `review-reminder:${recipientId}:${dateStr}`; // 每人每天一条
    if (await prisma.notification.findFirst({ where: { dedupeKey }, select: { id: true } })) continue;
    const pref = await prisma.notificationPref.findUnique({ where: { userId: recipientId } });
    const feishuState = pref && !pref.feishuEnabled ? "skipped" : "pending";
    const lang = appLang();
    const head = docs.slice(0, 5).map((d) => L(lang, `《${d.title}》(${d.count}处)`, `"${d.title}" (${d.count})`)).join(L(lang, "、", ", "));
    const excerpt = docs.length > 5 ? L(lang, `${head} 等 ${docs.length} 篇`, `${head} and ${docs.length - 5} more`) : head;
    await prisma.notification.create({
      data: {
        recipientId,
        actorId: null,
        type: "article_review_reminder",
        articleId: docs[0].id, // 卡片「查看文档」按钮跳转的代表文档
        payload: JSON.stringify({ actorName: L(lang, `${ASSISTANT_NAME} 体检`, `${ASSISTANT_NAME} Check`), articleTitle: L(lang, `你有 ${docs.length} 篇文档待优化`, `You have ${docs.length} ${docs.length === 1 ? "doc" : "docs"} to improve`), excerpt }),
        dedupeKey,
        feishuState,
      },
    });
    sent++;
  }
  if (sent > 0) {
    trackBestEffort(kickDispatch());
    log?.info({ sent }, "[article-review] 每日复检提醒已发出");
  }
  return sent;
}

let sending = false;
let lastRunDate = ""; // 内存态:当天已跑过就不再重复扫(DB dedupeKey 兜底跨重启)

/** 一跳:命中配置星期 + 时间窗口且今日未跑 → 发提醒。开关关/还原中/未命中/重入都安全 no-op。 */
export async function runReviewReminderTick(log?: FastifyBaseLogger): Promise<number> {
  if (sending || isRestoring()) return 0;
  let s;
  try {
    if (!(await getReminderEnabled())) return 0; // 关闭时早退,避免每分钟白读全部配置
    s = await getReminderSettings();
  } catch { return 0; }
  const b = beijingParts(Date.now());
  if (!s.reminderWeekdays.includes(b.dow)) return 0;
  const target = s.reminderHour * 60 + s.reminderMinute;
  if (b.minutes < target || b.minutes >= target + WINDOW_MIN) return 0;
  if (lastRunDate === b.dateStr) return 0; // 今日已在窗口内成功跑过
  sending = true;
  try {
    const sent = await sendReviewReminders(b.dateStr, log);
    // 仅在成功跑完后才标记今日已处理;若失败(如 DB 抖动),不置位 → 下一跳在 10min 窗口内重试
    //(每人每天 dedupeKey 幂等,重试不会重复发),避免一次瞬时失败把整天提醒跳过。
    lastRunDate = b.dateStr;
    return sent;
  } catch (err) {
    log?.warn?.({ err: (err as Error).message }, "[article-review] 每日提醒失败");
    return 0;
  } finally {
    sending = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** 启动每日提醒调度(index.ts 调用)。返回停止函数。 */
export function startReviewReminderScheduler(log?: FastifyBaseLogger): () => void {
  if (timer) return () => {};
  timer = setInterval(() => void runReviewReminderTick(log), 60_000);
  timer.unref?.();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
