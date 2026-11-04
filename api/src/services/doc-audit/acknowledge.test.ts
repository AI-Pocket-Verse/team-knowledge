import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../db.js";
import { acknowledgeFinding } from "./acknowledge.js";
import { setLastCard, getAcknowledgedHashes } from "./acks.js";
import { dedupeFindings } from "./findings.js";

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: ["doc.audit.last_card", "doc.audit.last_meta", "doc.audit.acknowledged"] } } });
});

// 从重建卡里找某 hash 对应勾选器的 checked 态。
function checkedOf(card: unknown, hash: string): boolean | undefined {
  const els = (card as { body?: { elements?: Array<{ tag?: string; checked?: boolean; behaviors?: Array<{ value?: { h?: string } }> }> } }).body?.elements ?? [];
  return els.find((e) => e.tag === "checker" && e.behaviors?.[0]?.value?.h === hash)?.checked;
}

describe("acknowledgeFinding(勾/取消两路)", () => {
  it("勾选 → 落库 + 回传重建卡(该条 checked=true)", async () => {
    const fs = dedupeFindings([{ category: "logic", docTitle: "A", problem: "p1", suggestion: "s" }]);
    await setLastCard(fs);
    const r = await acknowledgeFinding(fs[0].hash, "ou_1", true);
    expect(r.card).toBeTruthy();
    expect(r.toast).toContain("已确认");
    expect(await getAcknowledgedHashes()).toEqual(new Set([fs[0].hash]));
    expect(checkedOf(r.card, fs[0].hash)).toBe(true);
  });

  it("取消勾选 → 撤销确认(删库 + 该条 checked=false)", async () => {
    const fs = dedupeFindings([{ category: "logic", docTitle: "A", problem: "p1", suggestion: "s" }]);
    await setLastCard(fs);
    await acknowledgeFinding(fs[0].hash, "ou_1", true);
    const r = await acknowledgeFinding(fs[0].hash, "ou_1", false);
    expect(r.toast).toContain("撤销");
    expect(await getAcknowledgedHashes()).toEqual(new Set());
    expect(checkedOf(r.card, fs[0].hash)).toBe(false);
  });

  it("缺省 checked 视为勾选(兼容旧调用)", async () => {
    const fs = dedupeFindings([{ category: "logic", docTitle: "A", problem: "p1", suggestion: "s" }]);
    await setLastCard(fs);
    const r = await acknowledgeFinding(fs[0].hash, "ou_1");
    expect(await getAcknowledgedHashes()).toEqual(new Set([fs[0].hash]));
    expect(checkedOf(r.card, fs[0].hash)).toBe(true);
  });

  it("重建卡保留原始 docCount/检查时间(来自持久化 meta,非 findings 数/当前时刻)", async () => {
    const fs = dedupeFindings([{ category: "logic", docTitle: "A", problem: "p1", suggestion: "s" }]);
    await setLastCard(fs, { docCount: 12, generatedAt: "2026-06-10T01:00:00.000Z", truncated: 0 });
    const r = await acknowledgeFinding(fs[0].hash, "ou_1", true);
    const text = JSON.stringify(r.card);
    expect(text).toContain("12 篇"); // 真·文档数,而非 findings 数(1)
    expect(text).toContain("2026-06-10 09:00"); // 原始检查时间(北京)
  });

  it("hash 不在最新卡 → toast 兜底,不动库", async () => {
    await setLastCard(dedupeFindings([{ category: "logic", docTitle: "A", problem: "p1", suggestion: "s" }]));
    const r = await acknowledgeFinding("不存在的hash", "ou_1", true);
    expect(r.card).toBeNull();
    expect(r.toast).toContain("不在最新");
    expect(await getAcknowledgedHashes()).toEqual(new Set());
  });
});
