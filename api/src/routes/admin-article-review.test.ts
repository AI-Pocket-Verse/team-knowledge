import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { addDismissed, getDismissedHashes } from "../services/article-review/dismiss.js";
import { flushBestEffortWrites } from "../utils/guards.js";
import type { HashedReviewFinding } from "../services/article-review/findings.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

const finding = (hash: string, problem: string): HashedReviewFinding => ({ category: "logic", severity: "high", problem, suggestion: "改", hash });

describe("admin article-review 管理", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("GET issues 列出 reviewStatus=issues 的文档 + 解析后的 findings", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await prisma.article.create({ data: { title: "有问题", contentMarkdown: "x", roleId: role.id } });
    await prisma.article.create({ data: { title: "无问题", contentMarkdown: "y", roleId: role.id } });
    await prisma.$executeRaw`UPDATE "Article" SET "reviewStatus"='issues', "reviewFindings"=${JSON.stringify([finding("h1", "P")])} WHERE "id"=${a.id}`;
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/article-review/issues", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: a.id, title: "有问题", roleName: "产品" });
    expect(items[0].findings[0].problem).toBe("P");
    await app.close();
  });

  it("GET dismissed 列出忽略项(带标题),跳过已删/不存在文章", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await prisma.article.create({ data: { title: "甲", contentMarkdown: "x", roleId: role.id } });
    await addDismissed(a.id, [finding("h1", "问题甲")], "u1");
    await addDismissed("ghost-article", [finding("h2", "孤儿")], "u1"); // 文章不存在 → 应跳过
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/article-review/dismissed", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ articleId: a.id, articleTitle: "甲", hash: "h1", problem: "问题甲" });
    await app.close();
  });

  it("POST undismiss 从忽略集移除", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await prisma.article.create({ data: { title: "甲", contentMarkdown: "x", roleId: role.id } });
    await addDismissed(a.id, [finding("h1", "问题甲")], "u1");
    // 模拟已检状态:有 reviewedAt/reviewedHash —— 撤销忽略应清掉它们以保证必被复检。
    await prisma.$executeRaw`UPDATE "Article" SET "reviewedAt"=${Date.now()}, "reviewedHash"='oldhash' WHERE "id"=${a.id}`;
    expect((await getDismissedHashes(a.id)).has("h1")).toBe(true);
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: "/api/admin/article-review/undismiss", headers: { cookie: authCookie("admin"), "content-type": "application/json" }, payload: { articleId: a.id, hash: "h1" } });
    expect(res.statusCode).toBe(200);
    expect((await getDismissedHashes(a.id)).has("h1")).toBe(false);

    // ⚠️ 这里【不能】直接断言 reviewedAt 为 null。
    //
    // undismiss 清完 reviewedAt 后会立刻 fire-and-forget 触发一次复检
    // (routes/admin-article-review.ts 末尾的 trackBestEffort(reviewArticle(...))),
    // 而复检跑完会把 reviewedAt 写回(services/article-review/review.ts:221)。
    // 谁先谁后取决于复检多快 —— 这正是这条用例此前「单独跑红、全量跑绿」的原因:
    // 单独跑时复检抢在断言之前落库,全量跑时时序不同就没抢到。
    //
    // 实现没有错(复检完记录已检是应该的)。要守的性质是**撤销忽略之后这篇文档
    // 一定会被重新检查**,而不是「reviewedAt 永远是 null」那个瞬时状态。
    // 所以先把后台写排干,再断言复检确实发生过。
    await flushBestEffortWrites();
    const row = (await prisma.article.findUnique({ where: { id: a.id } }))!;
    // 复检要么还没写回(仍是 null)、要么写的是本次复检的新值 —— 无论哪种,
    // 那个「撤销忽略前的旧 hash」都必须已经不在了,否则扫描器会认为无需复检。
    expect(row.reviewedHash).not.toBe("oldhash");
    await app.close();
  });

  it("非 admin → 403", async () => {
    await seedUser({ ssoId: "ou_u" });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/article-review/issues", headers: { cookie: authCookie("ou_u") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
