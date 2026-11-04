// 勾选器交互的编排:按 hash 在最近一张卡里找到该条 → 勾(checked)落「已确认」/ 取消
// (!checked)撤销 → 用最新已确认集重建该卡(勾选器 checked 态)→ 回传 {toast, card}。
// hash 不在最新卡(旧卡 / 新审计后)→ toast 兜底,不动库、不回传卡。
import { getLastCard, getLastCardMeta, acknowledgeFindingRecord, unacknowledgeFindingRecord, getAcknowledgedHashes } from "./acks.js";
import { buildDocAuditCard } from "./audit.js";
import { L, appLang } from "../../utils/lang.js";

export interface AckResult {
  toast: string;
  card: unknown | null;
}

/** checked=true 勾选(确认/下次不提醒);checked=false 取消勾选(撤销确认)。 */
export async function acknowledgeFinding(hash: string, by: string, checked = true): Promise<AckResult> {
  const lastCard = await getLastCard();
  const finding = lastCard.find((f) => f.hash === hash);
  if (!finding) {
    return { toast: L(appLang(), "该条目已不在最新报告中,无需操作。", "This item is no longer in the latest report. Nothing to do."), card: null };
  }
  if (checked) await acknowledgeFindingRecord(finding, by);
  else await unacknowledgeFindingRecord(hash);
  const acked = await getAcknowledgedHashes();
  // 重建这张卡:仍展示 lastCard 全部条目,勾选器 checked 反映最新已确认集。meta(检查
  // 文档数 / 检查时间 / 截断)取原始体检持久化值,旧数据缺失时退回 findings 数 / 当前时刻。
  const meta = await getLastCardMeta();
  const card = buildDocAuditCard({
    findings: lastCard,
    acknowledgedHashes: acked,
    docCount: meta?.docCount ?? lastCard.length,
    truncated: meta?.truncated ?? 0,
    generatedAt: meta ? new Date(meta.generatedAt) : new Date(),
    llmFailed: false,
  });
  return { toast: checked ? L(appLang(), "已确认,下次不再提醒这条。", "Acknowledged. You will not be reminded about this one again.") : L(appLang(), "已撤销确认,该条下次仍会提醒。", "Acknowledgement undone. You will be reminded about this one again."), card };
}
