import type { WeeklyReportSnapshot } from "@team-knowledge/shared";
import { buildReportSvg } from "./svg.js";
import { renderSvgToPng } from "../image-render/resvg.js";

/** snapshot → PNG Buffer。SCALE 控清晰度;超 4.5MB 自动降一档(飞书 uploadImage 上限 5MB)。
 *  字体解析 + resvg 光栅化在 services/image-render/resvg.ts 共享(聊天图也用它)。 */
export async function renderReportPng(snapshot: WeeklyReportSnapshot): Promise<Buffer> {
  const baseSvg = buildReportSvg(snapshot);
  // 很高的长图(用户多)从 1.5x 起,削减 2x 全画布光栅化在事件循环上的阻塞与重复渲染;
  // 常规长度仍 2x 更清晰。高度取自 viewBox。
  const h = Number(baseSvg.match(/viewBox="0 0 \d+(?:\.\d+)? (\d+(?:\.\d+)?)"/)?.[1] ?? 0);
  const scales = h > 5000 ? [1.5, 1] : [2, 1.5, 1];
  return renderSvgToPng(baseSvg, { scales });
}
