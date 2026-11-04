// 文档体检「点击确认 / 下次不再提醒」的 Setting 持久化(免迁移)。两个 key:
//   doc.audit.last_card    最近一张卡的 findings(供点击时按 hash 重建卡)
//   doc.audit.acknowledged hash → 已确认条目(驱动下次抑制 + 卡片划掉态)
import { getSetting, setSetting } from "../settings.js";
import type { AuditFinding, HashedFinding } from "./findings.js";

const LAST_CARD_KEY = "doc.audit.last_card";
const LAST_META_KEY = "doc.audit.last_meta";
const ACK_KEY = "doc.audit.acknowledged";
const ACK_CAP = 500;

/** 卡片 meta(检查文档数 / 生成时刻 ISO / 截断篇数),与 last_card 一起存,供点击重建卡时
 *  保留原始体检的「检查文档:N 篇 / 检查时间」,而不是用 findings 数 + 当前时刻去近似。 */
export interface LastCardMeta { docCount: number; generatedAt: string; truncated: number; }

export interface AckedFinding extends AuditFinding {
  hash: string;
  ackedAt: number;
  ackedBy: string;
}

/** 超上限按「插入序」(ackedAt 升序)丢最旧,返回新对象。纯函数,便于测。 */
export function capAck<T extends { ackedAt: number }>(map: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const sorted = keys.sort((a, b) => map[a].ackedAt - map[b].ackedAt);
  const keep = sorted.slice(keys.length - max);
  const out: Record<string, T> = {};
  for (const k of keep) out[k] = map[k];
  return out;
}

export async function setLastCard(findings: HashedFinding[], meta?: LastCardMeta): Promise<void> {
  await setSetting(LAST_CARD_KEY, findings, "system:doc-audit");
  if (meta) await setSetting(LAST_META_KEY, meta, "system:doc-audit");
}
export async function getLastCard(): Promise<HashedFinding[]> {
  return getSetting<HashedFinding[]>(LAST_CARD_KEY, []);
}
export async function getLastCardMeta(): Promise<LastCardMeta | null> {
  return getSetting<LastCardMeta | null>(LAST_META_KEY, null);
}

async function getAckMap(): Promise<Record<string, AckedFinding>> {
  return getSetting<Record<string, AckedFinding>>(ACK_KEY, {});
}

// ack map 的「读-改-写」非原子(setSetting 整块覆盖 JSON)。这是「群里任何人都能勾」的
// 功能,多人同一时刻勾不同条会丢更新。用进程内串行锁把所有 ack 写串起来(team-knowledge 单
// 进程,足够);跨进程才需要 DB 事务/乐观锁。
let ackWriteChain: Promise<unknown> = Promise.resolve();
function withAckLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ackWriteChain.then(fn, fn);
  ackWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 记录一条已确认(幂等:同 hash 覆盖);超上限丢最旧。串行,避免并发丢更新。 */
export async function acknowledgeFindingRecord(f: HashedFinding, by: string): Promise<void> {
  await withAckLock(async () => {
    const map = await getAckMap();
    map[f.hash] = {
      category: f.category, docTitle: f.docTitle, problem: f.problem, suggestion: f.suggestion,
      hash: f.hash, ackedAt: Date.now(), ackedBy: by,
    };
    await setSetting(ACK_KEY, capAck(map, ACK_CAP), "system:doc-audit");
  });
}

/** 撤销一条已确认(取消勾选):删该 hash;不存在则无操作(幂等)。串行,同上。 */
export async function unacknowledgeFindingRecord(hash: string): Promise<void> {
  await withAckLock(async () => {
    const map = await getAckMap();
    if (!(hash in map)) return;
    delete map[hash];
    await setSetting(ACK_KEY, map, "system:doc-audit");
  });
}

export async function getAcknowledgedHashes(): Promise<Set<string>> {
  return new Set(Object.keys(await getAckMap()));
}

/** 全部已确认条目(≤ACK_CAP),供硬过滤(精确 hash + 模糊抗改写)比对文本。 */
export async function getAcknowledgedFindings(): Promise<AuditFinding[]> {
  const map = await getAckMap();
  return Object.values(map).map(({ category, docTitle, problem, suggestion }) => ({ category, docTitle, problem, suggestion }));
}

/** 最近 limit 条已确认条目(注入 prompt 做语义压制用,新→旧)。 */
export async function getAcknowledgedForPrompt(limit: number): Promise<AuditFinding[]> {
  const map = await getAckMap();
  return Object.values(map)
    .sort((a, b) => b.ackedAt - a.ackedAt)
    .slice(0, limit)
    .map(({ category, docTitle, problem, suggestion }) => ({ category, docTitle, problem, suggestion }));
}
