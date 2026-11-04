import { stripCnTz } from "../../utils/beijingWeek.js";
import { L, appLang } from "../../utils/lang.js";

export interface WeeklyReportImageCardInput {
  weekLabel: string;
  imageKey: string;
}

/** 知识库周报「图片」卡片:标题 + 大图(飞书原生点击放大)。标题去掉 weekLabel 里的
 *  「（北京时间）」;不带「查看完整周报」按钮。 */
export function buildWeeklyReportImageCard(i: WeeklyReportImageCardInput): unknown {
  const range = stripCnTz(i.weekLabel);
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: L(appLang(), `知识库周报 · ${range}`, `Knowledge Base Weekly Report · ${range}`) } },
    elements: [
      { tag: "img", img_key: i.imageKey, alt: { tag: "plain_text", content: L(appLang(), `知识库周报 ${range}`, `Knowledge Base Weekly Report ${range}`) } },
    ],
  };
}
