import { WEEKLY_REPORT_CSS } from "./weeklyReportCss";
import { currentLang } from "@/i18n/lang";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** 导出 / 打印用的自包含 HTML 文档。title 来自快照数据,写进 document.write 之前必须转义。 */
export function buildStandaloneReportHtml(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${WEEKLY_REPORT_CSS}</style></head><body>${bodyHtml}</body></html>`;
}
