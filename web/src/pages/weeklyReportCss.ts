// 周报样式字符串 —— 同时用于页面内 <style> 注入与「导出 HTML / 打印 PDF」的自包含
// 文档(整段内联),保证屏幕与导出一致。class 用 wr- 前缀,不依赖 Tailwind。
export const WEEKLY_REPORT_CSS = `
.wr-root {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color: #1d2129; background: #fff; padding: 24px; max-width: none; margin: 0; width: 100%;
}
.wr-h1 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
.wr-sub { font-size: 13px; color: #86909c; margin: 0 0 8px; }
.wr-summary { font-size: 14px; line-height: 1.7; color: #4e5969; background: #f7f9fc; border: 1px solid #eef1f5; border-radius: 10px; padding: 12px 16px; margin: 10px 0 0; }
.wr-section { margin-top: 26px; }
.wr-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
.wr-section-head .wr-section-title { margin: 0; }
.wr-section-title { font-size: 15px; font-weight: 600; margin: 0 0 12px; padding-left: 9px; border-left: 3px solid #3370ff; line-height: 1.2; }
.wr-userpick { font-size: 13px; color: #4e5969; display: inline-flex; align-items: center; gap: 6px; }
.wr-userpick select { font-size: 13px; padding: 4px 8px; border: 1px solid #d9dce1; border-radius: 8px; background: #fff; color: #1d2129; max-width: 220px; }
.wr-pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; font-size: 13px; color: #86909c; }
.wr-pager button { font-size: 13px; padding: 3px 12px; border: 1px solid #d9dce1; border-radius: 8px; background: #fff; color: #1d2129; cursor: pointer; }
.wr-pager button:disabled { color: #c9cdd4; cursor: not-allowed; background: #f7f8fa; }
.wr-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.wr-card { border: 1px solid #eef1f5; border-radius: 12px; padding: 14px 16px; background: #fff; }
.wr-card-label { font-size: 12px; color: #86909c; }
.wr-card-value { font-size: 24px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
.wr-card-hint { font-size: 11px; color: #c9cdd4; margin-top: 3px; }
.wr-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.wr-chart-box { border: 1px solid #eef1f5; border-radius: 12px; padding: 12px 12px 8px; background: #fff; }
.wr-chart-title { font-size: 13px; font-weight: 600; color: #4e5969; margin: 0 0 6px; }
.wr-chart { width: 100%; height: 280px; }
.wr-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; }
.wr-legend span { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #4e5969; }
.wr-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.wr-table-wrap { overflow-x: auto; border: 1px solid #eef1f5; border-radius: 12px; }
.wr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.wr-table th, .wr-table td { padding: 8px 12px; border-bottom: 1px solid #f2f3f5; text-align: right; white-space: nowrap; }
.wr-table th:first-child, .wr-table td:first-child { text-align: left; }
.wr-table th:nth-child(2), .wr-table td:nth-child(2) { text-align: left; }
.wr-table thead th { color: #86909c; font-weight: 600; border-bottom: 1px solid #e5e6eb; background: #fafbfc; }
.wr-table tbody tr:hover { background: #f7f9fc; }
.wr-rank { color: #c9cdd4; width: 28px; }
.wr-name { font-weight: 600; }
.wr-live { list-style: none; margin: 0; padding: 0; border: 1px solid #eef1f5; border-radius: 12px; }
.wr-live li { display: flex; gap: 10px; align-items: baseline; padding: 9px 14px; border-bottom: 1px solid #f7f8fa; font-size: 13px; }
.wr-live li:last-child { border-bottom: none; }
.wr-live .t { color: #86909c; font-size: 12px; white-space: nowrap; min-width: 92px; }
.wr-live .who { font-weight: 600; min-width: 84px; }
.wr-live .ttl { color: #4e5969; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wr-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: #e8f3ff; color: #1d6fea; white-space: nowrap; }
.wr-userlink { color: #1d6fea; cursor: pointer; background: none; border: none; padding: 0; font: inherit; }
.wr-userlink:hover { text-decoration: underline; }
.wr-empty { padding: 28px; text-align: center; color: #86909c; font-size: 13px; }
.wr-chart-note { font-size: 11px; color: #c9cdd4; margin-top: 6px; }
.wr-delta { display: inline-block; margin-left: 4px; font-size: 11px; line-height: 1; font-weight: 700; vertical-align: middle; }
.wr-delta.up { color: rgba(245, 63, 63, 0.55); }
.wr-delta.down { color: rgba(0, 180, 42, 0.5); }
@media (max-width: 760px) { .wr-cards { grid-template-columns: repeat(2, 1fr); } .wr-charts { grid-template-columns: 1fr; } }
@media print { .wr-root { padding: 0; max-width: none; } .wr-section, .wr-chart-box, .wr-card { break-inside: avoid; } }
`;
