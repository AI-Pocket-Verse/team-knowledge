// 「知识库周报(图片)」场景的卡片组装:取上一完整周 → 出图 → 上传飞书 → 图片卡片。
// 单独成文件,供 notify-test(SCENARIOS.build)与 notify-cron(JOBS.buildCard)共用,
// 不让 notify-cron 反向依赖 notify-test/index。任一步失败降级为文字摘要卡。
import { env } from "../../env.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { stripCnTz } from "../../utils/beijingWeek.js";
import { applinkWrap } from "../../utils/notify/card.js";
import { finalizePreviousWeek, getWeeklyReport } from "../weekly-report.js";
import { notifyAdminsOfWeeklyReport } from "../../utils/notify/adminAlert.js";
import { renderReportPng } from "./render.js";
import { buildWeeklyReportImageCard } from "./card.js";

export async function buildKbWeeklyReportCard(now: Date = new Date()): Promise<unknown> {
  const r = await finalizePreviousWeek(now);
  const detail = await getWeeklyReport(r.id);
  const snapshot = detail?.snapshot;
  // 若本任务恰是该周「首次定稿」(周一 00:00 定稿调度失败/被跳过时可能发生),补发
  // 管理员私聊摘要 —— 与 weekly-report 调度器同一去重口径(firstFinalize),不会重复发。
  if (snapshot && r.firstFinalize) {
    void notifyAdminsOfWeeklyReport({ id: r.id, weekLabel: snapshot.weekLabel, summary: snapshot.summary ?? "" }).catch(() => { /* best-effort */ });
  }
  if (!snapshot) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "知识库周报" } },
      elements: [{ tag: "div", text: { tag: "plain_text", content: "本周暂无周报数据。" } }],
    };
  }
  try {
    const png = await renderReportPng(snapshot);
    const { imageKey } = await feishuGateway.uploadImage(png);
    return buildWeeklyReportImageCard({ weekLabel: snapshot.weekLabel, imageKey });
  } catch (e) {
    // 出图/上传失败 → 降级文字摘要卡(群里至少有内容)。reason 进 stderr(结构化日志在
    // 上层 fireJob/sendScenario,此处只为可观测)。
    console.error("[kb_weekly_report] 图片渲染/上传失败,降级文字卡:", e);
    const url = `${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/admin/weekly-report/${r.id}`;
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: `知识库周报 · ${stripCnTz(snapshot.weekLabel)}` } },
      elements: [
        { tag: "div", text: { tag: "plain_text", content: `${stripCnTz(snapshot.summary ?? "本周周报")}（图片渲染失败，点按钮查看完整周报）` } },
        {
          tag: "action",
          actions: [
            { tag: "button", text: { tag: "plain_text", content: "查看完整周报" }, type: "primary", url: applinkWrap(url, env.FEISHU_CARD_USE_APPLINK) },
          ],
        },
      ],
    };
  }
}
