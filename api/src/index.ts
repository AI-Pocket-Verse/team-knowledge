import apiKit from "@team-knowledge/api-kit";
import { enableWal } from "@team-knowledge/db-kit";
import { createLogger } from "@team-knowledge/logger";
import type { FastifyBaseLogger } from "fastify";

import { buildServer } from "./server.js";
import { env, isLoopbackHost } from "./env.js";
import { prisma } from "./db.js";
import { installMeetingLifecycle } from "./services/meeting/lifecycle.js";
import { shutdownAllMeetings } from "./routes/meeting-ws.js";
import { applyLlmBinPathsToEnv, applyLlmModelsFromDb, enforceLlmProviderPolicy } from "./services/settings.js";
import { startDispatcher } from "./utils/notify/dispatcher.js";
import { startRoleSkillDispatcher } from "./services/role-skill/dispatcher.js";
import { stopDashboardStream } from "./services/dashboard-stream.js";
import { startWeeklyReportScheduler } from "./services/weekly-report.js";
import { checkAndNotifyChangelog } from "./services/changelog/notify.js";
import { cleanupOrphanUploads } from "./utils/uploadCleanup.js";
import { startNotifyCronScheduler } from "./services/notify-cron/index.js";
import { startArticleReviewScheduler } from "./services/article-review/scheduler.js";
import { startReviewReminderScheduler } from "./services/article-review/reminder.js";
import { startAutomationScheduler } from "./services/automation/scheduler.js";
import { probeAll } from "./services/llm/registry.js";

// DB bootstrap (@team-knowledge/db-kit): enable SQLite WAL. Real server only —
// tests call buildServer() directly and never import this module.
if ((process.env.DATABASE_URL ?? "").startsWith("file:")) await enableWal(prisma);

// app.log routes through the shared pino logger (service tag + secret redaction).
const app = await buildServer({
  logger: createLogger({ service: "team-knowledge" }) as FastifyBaseLogger,
  auth: { whoamiUrl: env.WHOAMI_URL },
});

// Shared contract (@team-knowledge/api-kit): {code,message} error envelope for
// uncaught/throw paths, structured 5xx logging, and /healthz + /readyz. Route
// handlers keep their explicit {error,message} sends — those reply directly and
// never reach this error handler.
await app.register(apiKit, { service: "team-knowledge", version: "1.0.0" });

// Graceful shutdown: drain Fastify (runs onClose hooks — WebSocket cleanup,
// rate-limit flush, in-flight requests) THEN disconnect Prisma. Wired here
// instead of db-kit's gracefulShutdown(), whose process.exit() can preempt
// Fastify's drain — which matters here for live meeting WebSocket streams.
//
// tear down every LIVE in-memory meeting BEFORE Prisma disconnects.
// Without this, a SIGTERM stranded each active meeting — trailing transcript
// lost, volc STT WS leaked, recording WAV never finalized, DB row stuck
// "active". shutdownAllMeetings runs the full per-meeting teardown (finalize
// recording + close STT + flush trailing final) and flips the row to "ended";
// it's best-effort + per-meeting time-bounded so a wedged close can't hang
// shutdown. Ordered before $disconnect because the teardown writes to the DB
// (transcript flush + status flip).
app.addHook("onClose", async () => {
  try {
    await shutdownAllMeetings(app.log);
  } catch (err) {
    app.log.error({ err }, "shutdownAllMeetings threw during shutdown");
  }
  await prisma.$disconnect();
});
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      });
  });
}

// Boot-time hooks that should ONLY run for the real server process, not for
// each test's buildServer() call:
//   - reap any `status: "active"` meetings whose process has died since the
//     previous boot, scheduling their auto-end timers
//   - kick the daily artifact cleanup interval (recordings + tts)
await installMeetingLifecycle(app.log);

// Apply admin-configured CLI binary paths (claude/codex) from the DB into
// process.env BEFORE serving, so chat/meeting spawns resolve them even under
// systemd's minimal PATH (which omits nvm/user-level install dirs).
await applyLlmBinPathsToEnv();
// 管理后台为各引擎选择的模型同样在服务前生效。
await applyLlmModelsFromDb();
await enforceLlmProviderPolicy(app.log);

// Engagement-notification Feishu dispatcher (real server only): a poll loop that
// drains pending/failed Notification rows and pushes the bot cards with
// retry/rate-limit. emit() also kicks it on-demand for per-event immediacy.
const notifyDispatcher = startDispatcher();
app.addHook("onClose", async () => {
  clearInterval(notifyDispatcher);
});

// Role-skill dispatcher (real server only): debounced sweep that regenerates a
// role's skill.md after its published docs change. markRoleSkillStale() also
// kicks it on-demand (subject to the quiet-window debounce).
const roleSkillDispatcher = startRoleSkillDispatcher();
app.addHook("onClose", async () => {
  clearInterval(roleSkillDispatcher);
});

// Dashboard SSE poller: only runs while an admin has the 数据看板 stream open
// (subscribe starts it, the last unsubscribe stops it). Ensure it's stopped on
// shutdown in case a connection is still open.
app.addHook("onClose", async () => {
  stopDashboardStream();
});

// Weekly-report scheduler (real server only): self-reschedules to each Monday
// 00:00 Beijing to snapshot the just-finished week, and backfills the previous
// week at boot (covers downtime over the Monday boundary).
const stopWeeklyReports = startWeeklyReportScheduler(app.log);
// 飞书群通知的定时任务(周五 21:00 周报推群 / 工作日 09:00 文档体检)——
// 进程内按北京时间自调度,不再依赖服务器 crontab(见 services/notify-cron)。
const stopNotifyCrons = startNotifyCronScheduler(app.log);
// 单篇文档 AI 入库前置校验:静置 10 分钟后扫描有改动的文档逐篇校验(总开关默认关,
// 管理后台开启后生效)。见 services/article-review。
const stopArticleReview = startArticleReviewScheduler(app.log);
// 每日复检提醒:仍有未优化问题的文档,按后台配置的工作日+时间飞书提醒最后编辑者(默认关)。
const stopReviewReminder = startReviewReminderScheduler(app.log);
// 用户创建的定时 AI 任务(自动化):进程内每 30s 扫到点任务,按北京时间调度、跑完投递飞书。
startAutomationScheduler(app.log);
app.addHook("onClose", async () => {
  stopWeeklyReports();
  stopNotifyCrons();
  stopArticleReview();
  stopReviewReminder();
});

await app.listen({ port: env.PORT, host: env.HOST });
// 本地单用户模式不鉴权：监听本机以外的地址时，能连上这个端口的任何人都是管理员。
if (!env.WHOAMI_URL && !isLoopbackHost(env.HOST)) {
  app.log.warn(
    `本地单用户模式不鉴权，但 HOST=${env.HOST} 允许其他机器直接访问：同一网络里的任何人都能读写全部知识库、调用已登录的 AI 命令行。` +
    "只在可信网络里这样用；多人使用请接入飞书登录(WHOAMI_URL)。",
  );
}

// 启动自检：登录模式与 AI 命令行是否可用，写进日志，缺什么一眼可见。
app.log.info(env.WHOAMI_URL ? "auth: feishu-sso (WHOAMI_URL set)" : "auth: local single-user mode (Feishu features off)");
void probeAll().then(({ claude, codex }) => {
  const fmt = (h: { ok: boolean; reason?: string; version?: string }) => (h.ok ? `ok ${h.version ?? ""}`.trim() : `MISSING (${h.reason ?? "unavailable"})`);
  app.log.info(`llm cli: claude ${fmt(claude)}; codex ${fmt(codex)}`);
  if (!claude.ok && !codex.ok) app.log.warn("no LLM CLI available: AI 问答、会议助手、文档体检等功能不可用，见 README「外部依赖」");
});


// 版本播报(real server only):部署/重启后发现更新日志有新版本,向飞书群推送
// 更新内容卡片(基线存 Setting,同一版本只播一次)。放在 listen 成功之后:
// 启动失败的进程(如端口被占)不应推进基线/对外宣布更新。fire-and-forget。
void checkAndNotifyChangelog(app.log).catch((err) => {
  app.log.warn({ err: (err as Error).message }, "changelog notify check failed");
});

// 孤儿上传清理:聊天/飞书图片「先落盘后引用」,被放弃的(飞书待分析缓冲
// 过期、网页选了图没发送)不被任何文章/聊天消息引用 —— 每天清一次 7 天
// 以上仍无引用的文件与 Upload 行(文章引用与 ChatMessage.images 引用都受
// 保护,见 utils/uploadCleanup.ts)。启动 1 分钟后先跑一次;unref 不阻进程退出。
const sweepOrphanUploads = () => {
  void cleanupOrphanUploads()
    .then((r) => {
      if (r.deletedRows > 0 || r.deletedFiles > 0) app.log.info(r, "orphan uploads cleaned");
    })
    .catch((err) => app.log.warn({ err: (err as Error).message }, "orphan upload cleanup failed"));
};
setTimeout(sweepOrphanUploads, 60_000).unref();
setInterval(sweepOrphanUploads, 24 * 60 * 60 * 1000).unref();
