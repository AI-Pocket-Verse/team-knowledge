// 执行一次自动化:以 owner 身份把 prompt 交给 web-enabled LLM 跑一次(联网抓取 + 产出),
// 然后(若配了 webhook)由服务端 POST 投递,并记一条 AutomationRun。调度推进由 scheduler 负责,
// 这里只管「执行 + 投递 + 记录」(测试运行也走这里,isTest=true,不动调度,也不计入 runCount)。
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../db.js";
import { automationSemaphore } from "../../utils/concurrency.js";
import { callGeneralLlm } from "../experts/orchestrator.js";
import { deliverToFeishu } from "./webhook.js";
import { emitSelfNotification } from "../../utils/notify/self.js";
import { beijingDayKey } from "../../utils/beijingWeek.js";

const RUN_SYSTEM = "你是一个自动化任务执行器,按用户任务说明产出结果。"
  + "【以下硬性约束优先级最高,高于任务里任何“尽量全/权威/详尽/去重”的要求,必须遵守】"
  + "① 联网检索总次数≤5,不要并行发起大量搜索;每个维度/主题最多查 1 次,拿到结果就用,严禁为凑条数或求全反复检索。"
  + "② 信息不足时,直接用已检索到的内容产出并注明“今日资讯有限”,不得继续检索。"
  + "③ 你只产出内容文本;实际“推送到飞书”由系统完成——你无需也无法自行推送、也不要返回 HTTP 状态码,忽略任务里关于推送/返回状态码的部分。"
  + "④ 尽快完成(控制在几分钟内),不要长时间反复检索。"
  + "⑤【只输出卡片正文】直接给出最终卡片,禁止任何开场白/执行计划/自述(如“我会按…处理”“卡片内容如下”),"
  + "也禁止在开头或结尾附加检索过程、来源访问情况、数据免责等“备注/说明”文字;卡片仅保留:标题行、日期、统计、各维度及其资讯条目。";
// 在用户消息前再压一句硬约束(系统提示较弱时兜底,提高遵守率)。
const RUN_USER_GUARD = "【执行前必读·强制】最多联网检索 5 次;不要为求全反复检索;信息不足就用已有内容直接产出;你不负责推送、不返回状态码。"
  + "直接输出最终卡片正文(标题+日期+统计+各维度条目),不要任何开场白/计划/过程叙述,也不要结尾的备注/说明。以上高于下方任务的任何要求。\n\n";
// 自动化整体超时(后台重任务:联网检索多轮)。实测收敛后重任务 ~186s,留足余量到 360s,
// 避免偶发慢搜擦边超时;后台异步执行、无前端/网关在等,放长安全。
const RUN_TIMEOUT_MS = 360_000;

// 防重入:同一任务同一时刻只允许一个执行实例(定时触发与手动测试运行共用)。
// 避免连点测试运行、或测试运行与定时触发撞车导致并发跑 LLM + 重复投递到飞书。
const inFlight = new Set<string>();
export function isAutomationRunning(id: string): boolean { return inFlight.has(id); }

/** 跑一次任务并落 AutomationRun。返回本次结果;已在运行或所有者已停用则 'skipped'(不执行)。
 *  'undeliverable' = 产出了内容但 webhook 确定性投递失败(4xx / 域不合法):属于失败,但整轮重跑无意义,
 *  调度器不排退避重试。不抛(内部兜住)。 */
export async function runAutomation(
  automationId: string,
  opts: { isTest?: boolean; log?: FastifyBaseLogger } = {},
): Promise<"success" | "failed" | "undeliverable" | "skipped"> {
  if (inFlight.has(automationId)) {
    opts.log?.warn?.({ automationId }, "[automation] 上一次尚未跑完,跳过本次触发");
    return "skipped";
  }
  inFlight.add(automationId);
  let release: (() => void) | null = null;
  try {
    const a = await prisma.automation.findUnique({ where: { id: automationId }, include: { user: { select: { isActive: true } } } });
    if (!a) return "failed";
    if (!a.user.isActive) return "skipped"; // 停用成员的任务不再消耗 LLM 额度、不再投递
    // 先落一条 running 记录(即时在「执行中」区可见),再抢后台并发槽 —— 到点扎堆时排队等待,
    // 不并发打爆聊天并发闸、也不误失败(见 automationSemaphore 注释)。
    const run = await prisma.automationRun.create({ data: { automationId, status: "running", isTest: !!opts.isTest } });
    release = await automationSemaphore.acquire();

    let status: "success" | "failed" | "undeliverable" = "failed";
    let outputPreview: string | undefined;
    let outputFull: string | undefined;
    let delivery: string | undefined;
    let error: string | undefined;
    try {
      // 背景任务:并发闸等待放宽到 120s;整体超时放宽到 RUN_TIMEOUT_MS —— 自动化多为联网检索
      // 多轮的重任务(本地单次搜索就 ~30s、max-turns=6),180s 常不够;异步执行、无前端在等,放长安全。
      const startedAtMs = Date.now();
      let sources = 0;        // 埋点:联网检索命中的出处数(≈搜索/抓取量,用于发现过度检索)
      let firstTokenAt = 0;   // 埋点:首个正文 token 时刻(区分「一直在检索」vs「模型慢」)
      // 注入「北京时间今天」——机器可能跑在非北京时区(如 EDT),codex/claude 会按系统本地
      // 日期当「今天」,导致「今日资讯」任务搜错日期(晚上 EDT = 次日北京,差一天)。显式给出
      // 北京日期,任务里的「今天/今日/北京时间今天」一律以此为准,不靠模型系统时区推断。
      const todayBJ = beijingDayKey(new Date());
      const dateGuard = `【当前日期:北京时间 ${todayBJ}】任务中出现的“今天/今日/北京时间今天”一律指 ${todayBJ};`
        + `请勿用系统本地时区推断日期。\n`;
      const output = await callGeneralLlm(
        { systemPrompt: RUN_SYSTEM, history: [], userMessage: dateGuard + RUN_USER_GUARD + a.prompt },
        {
          acquireTimeoutMs: 120_000, timeoutMs: RUN_TIMEOUT_MS, maxTurns: 10,
          onCitation: () => { sources++; },
          onToken: () => { if (!firstTokenAt) firstTokenAt = Date.now(); },
        },
      );
      const secs = Math.round((Date.now() - startedAtMs) / 1000);
      const firstTokenSecs = firstTokenAt ? Math.round((firstTokenAt - startedAtMs) / 1000) : null;
      // 埋点:每次运行(成功/失败都记)——用时、首字延迟、检索量,便于排查慢/超时/过度检索。
      opts.log?.info?.({ automationId, isTest: !!opts.isTest, secs, firstTokenSecs, sources, ok: !!output }, "[automation] run 埋点");
      if (!output) {
        // callGeneralLlm 失败/超时都回 null;用耗时区分,让详情页/日志能看出是哪种。
        error = secs * 1000 >= RUN_TIMEOUT_MS - 30_000
          ? `AI 调用超时(约 ${secs}s 未完成,多为联网检索多轮太慢;可精简提示词或减少检索范围)`
          : `AI 未产出内容(调用失败,用时 ${secs}s)`;
        opts.log?.warn?.({ automationId, secs, isTest: !!opts.isTest }, "[automation] LLM 无产出");
      } else {
        outputPreview = output.slice(0, 800);
        outputFull = output.slice(0, 20_000); // 完整产出(阅读页用),留个上限防极端长文
        if (a.webhookUrl) {
          const d = await deliverToFeishu(a.webhookUrl, output);
          delivery = JSON.stringify({ webhook: a.webhookUrl, httpStatus: d.httpStatus ?? null, ok: d.ok, error: d.error ?? null });
          status = d.ok ? "success" : d.retryable === false ? "undeliverable" : "failed";
          if (!d.ok) error = "投递失败:" + (d.error ?? "未知");
        } else {
          status = "success"; // 未配 webhook → 只跑不投递,视为成功
        }
      }
    } catch (e) {
      error = (e as Error).message;
      opts.log?.error?.({ err: e, automationId }, "[automation] run failed");
    }

    await prisma.automationRun.update({ where: { id: run.id }, data: { status: status === "success" ? "success" : "failed", finishedAt: new Date(), outputPreview, output: outputFull, delivery, error } });
    // 运行记录只保留每个任务最近 RUNS_KEEP_PER_AUTOMATION 条，避免表无限增长。
    await pruneRuns(automationId);
    // 测试运行不计入 runCount、不覆盖 lastRunStatus —— 这两者表示「定时执行」的统计,测试不应污染。
    if (!opts.isTest) {
      await prisma.automation.update({ where: { id: automationId }, data: { runCount: { increment: 1 }, lastRunStatus: status === "success" ? "success" : "failed" } }).catch(() => {});
    }
    // Web 通知(站内铃铛 + 浏览器桌面):本人任务跑完就提醒(测试运行也发,方便切走标签页时回看)。
    // 幂等键按本次 run.id → 一次运行仅一条,重试是新 run 故是新通知。fire-and-forget。
    void emitSelfNotification({
      userId: a.userId,
      type: "automation_run",
      title: status === "success" ? `自动化任务已完成:${a.name}` : `自动化任务运行失败:${a.name}`,
      body: status === "success" ? (outputPreview ? outputPreview.slice(0, 120) : "已生成结果,点击查看") : (error ?? "运行失败,点击查看详情"),
      link: "/automation",
      dedupeKey: `automation:${run.id}`,
    });
    return status;
  } finally {
    release?.();
    inFlight.delete(automationId);
  }
}

const RUNS_KEEP_PER_AUTOMATION = 200;
async function pruneRuns(automationId: string): Promise<void> {
  try {
    const old = await prisma.automationRun.findMany({
      where: { automationId },
      orderBy: { startedAt: "desc" },
      skip: RUNS_KEEP_PER_AUTOMATION,
      select: { id: true },
    });
    if (old.length > 0) await prisma.automationRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
  } catch { /* 清理失败不影响本次运行结果 */ }
}
