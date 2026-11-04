import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../db.js";
import { setLastCard, getLastCard, getLastCardMeta, acknowledgeFindingRecord, unacknowledgeFindingRecord, getAcknowledgedHashes, getAcknowledgedForPrompt, capAck } from "./acks.js";
import { dedupeFindings } from "./findings.js";

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: ["doc.audit.last_card", "doc.audit.last_meta", "doc.audit.acknowledged"] } } });
});

const F = (h: string, problem: string) => ({ category: "logic" as const, docTitle: "X", problem, suggestion: "s", hash: h });

describe("capAck(纯函数)", () => {
  it("超上限按插入序丢最旧", () => {
    const m: Record<string, { ackedAt: number }> = {};
    for (let i = 0; i < 5; i++) m[`h${i}`] = { ackedAt: i };
    const out = capAck(m, 3);
    expect(Object.keys(out)).toEqual(["h2", "h3", "h4"]);
  });
  it("未超上限原样返回", () => {
    const m = { a: { ackedAt: 1 } };
    expect(capAck(m, 3)).toBe(m);
  });
});

describe("last_card / acknowledged round-trip", () => {
  it("setLastCard / getLastCard", async () => {
    const fs = dedupeFindings([{ category: "logic", docTitle: "A", problem: "p", suggestion: "s" }]);
    await setLastCard(fs);
    expect(await getLastCard()).toHaveLength(1);
  });
  it("acknowledge 落库,hashes 含之,prompt 取回正文", async () => {
    await acknowledgeFindingRecord(F("abc", "步骤矛盾"), "ou_1");
    expect(await getAcknowledgedHashes()).toEqual(new Set(["abc"]));
    const p = await getAcknowledgedForPrompt(10);
    expect(p[0].problem).toBe("步骤矛盾");
  });
  it("unacknowledge 删除该 hash(幂等)", async () => {
    await acknowledgeFindingRecord(F("abc", "步骤矛盾"), "ou_1");
    await acknowledgeFindingRecord(F("def", "另一个"), "ou_1");
    await unacknowledgeFindingRecord("abc");
    expect(await getAcknowledgedHashes()).toEqual(new Set(["def"]));
    await unacknowledgeFindingRecord("abc"); // 再删不存在的,不报错
    expect(await getAcknowledgedHashes()).toEqual(new Set(["def"]));
  });

  it("并发记录多条 ack 不丢更新(串行锁;无锁时读-改-写会互相覆盖)", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => acknowledgeFindingRecord(F(`h${i}`, `p${i}`), "ou_1")));
    expect((await getAcknowledgedHashes()).size).toBe(12);
  });

  it("setLastCard 带 meta → getLastCardMeta 取回(docCount/检查时间/截断)", async () => {
    const fs = dedupeFindings([{ category: "logic", docTitle: "A", problem: "p", suggestion: "s" }]);
    await setLastCard(fs, { docCount: 12, generatedAt: "2026-06-10T01:00:00.000Z", truncated: 2 });
    expect(await getLastCardMeta()).toEqual({ docCount: 12, generatedAt: "2026-06-10T01:00:00.000Z", truncated: 2 });
  });
});
