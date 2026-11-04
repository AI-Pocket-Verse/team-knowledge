import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { selectReviewCandidates } from "./scheduler.js";
import { invalidateAssistantExclusionCache } from "../assistant-filter/exclusions.js";

const LONG = "这是一段足够长的正文用于校验校验校验。";
const old = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);

describe("selectReviewCandidates", () => {
  beforeEach(async () => { await resetDb(); invalidateAssistantExclusionCache(); });
  afterAll(async () => { await disconnectDb(); });

  async function mk(title: string, patch: { updatedAt?: Date; reviewedAt?: Date | null; editingById?: string | null; editingAt?: Date | null } = {}) {
    const role = await prisma.role.create({ data: { name: `r-${title}` } });
    const a = await prisma.article.create({ data: { title, contentMarkdown: LONG, roleId: role.id } });
    // 用 raw 设置 updatedAt/review 字段,避免 prisma.update bump updatedAt
    await prisma.$executeRaw`UPDATE "Article" SET "updatedAt" = ${patch.updatedAt ?? old(20)}, "reviewedAt" = ${patch.reviewedAt ?? null}, "editingById" = ${patch.editingById ?? null}, "editingAt" = ${patch.editingAt ?? null} WHERE "id" = ${a.id}`;
    return a;
  }

  it("选出静置满 10 分钟、从未 review 的文档", async () => {
    const a = await mk("待检", { updatedAt: old(20), reviewedAt: null });
    const ids = (await selectReviewCandidates(new Date())).map((c) => c.id);
    expect(ids).toContain(a.id);
  });

  it("跳过:刚改过(未满 10 分钟)/ 已 review 且内容未变 / 编辑锁活跃", async () => {
    await mk("刚改", { updatedAt: old(2), reviewedAt: null });
    await mk("已检未变", { updatedAt: old(30), reviewedAt: old(20) }); // reviewedAt >= updatedAt
    const u = await seedUser({ ssoId: "ou_lock" });
    await mk("编辑中", { updatedAt: old(30), reviewedAt: null, editingById: u.id, editingAt: old(0) });
    const ids = (await selectReviewCandidates(new Date())).map((c) => c.id);
    expect(ids).toHaveLength(0);
  });

  it("跳过被内容过滤排除的文档", async () => {
    const a = await mk("被排除", { updatedAt: old(20), reviewedAt: null });
    await prisma.assistantExclusion.create({ data: { targetType: "article", targetId: a.id, createdById: "x" } });
    invalidateAssistantExclusionCache();
    const ids = (await selectReviewCandidates(new Date())).map((c) => c.id);
    expect(ids).not.toContain(a.id);
  });

  it("需复检谓词在 DB 侧:大量已检旧文档不会把新编辑的文档挤出候选(防饿死)", async () => {
    // 多篇「已检且内容未变」(reviewedAt 晚于 updatedAt)——它们在 DB 侧就被排除,
    // 不占 LIMIT 窗口;唯一一篇「需复检」(reviewedAt 早于 updatedAt)必须被选中。
    for (let i = 0; i < 8; i++) {
      await mk(`已检${i}`, { updatedAt: old(30 + i), reviewedAt: old(5) }); // reviewedAt(now-5) > updatedAt → 已检
    }
    const fresh = await mk("新编辑需复检", { updatedAt: old(12), reviewedAt: old(40) }); // reviewedAt(now-40) < updatedAt(now-12) → 需复检
    const ids = (await selectReviewCandidates(new Date())).map((c) => c.id);
    expect(ids).toContain(fresh.id);
  });
  it("前面一批过短文档不会把后面的长文档挤出窗口,且被跳过的行写回 reviewedAt", async () => {
    const role = await prisma.role.create({ data: { name: "r-short" } });
    const t = old(120);
    await prisma.article.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({ id: `short${String(i).padStart(3, "0")}`, title: `短${i}`, contentMarkdown: "x", roleId: role.id })),
    });
    const long = await prisma.article.create({ data: { id: "zlong", title: "真正需要校验的长文档", contentMarkdown: LONG, roleId: role.id } });
    await prisma.$executeRaw`UPDATE "Article" SET "updatedAt" = ${t}, "reviewedAt" = NULL`;
    const ids = (await selectReviewCandidates(new Date())).map((c) => c.id);
    expect(ids).toEqual([long.id]);
    // 过短的行已标记为「已检」,下一轮不再占窗口
    const left = await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*) AS n FROM "Article" WHERE "reviewedAt" IS NULL`;
    expect(Number(left[0].n)).toBe(1);
  });
});
