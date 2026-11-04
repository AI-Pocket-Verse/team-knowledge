import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { sendReviewReminders } from "./reminder.js";

describe("article-review 每日复检提醒", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function seedIssue(title: string, authorId: string, findingCount: number) {
    const role = await prisma.role.create({ data: { name: `角色-${title}` } });
    return prisma.article.create({
      data: {
        title, contentMarkdown: "正文", roleId: role.id, createdById: authorId,
        reviewStatus: "issues",
        reviewFindings: JSON.stringify(Array.from({ length: findingCount }, (_, i) => ({ hash: `${title}-${i}` }))),
      },
    });
  }

  it("按最后编辑者聚合成每人一条;当天 dedupe 不重复", async () => {
    const a = await seedUser({ ssoId: "ou_a" });
    const b = await seedUser({ ssoId: "ou_b" });
    await seedIssue("文档1", a.id, 2);
    await seedIssue("文档2", a.id, 1);
    await seedIssue("文档3", b.id, 1);

    const sent = await sendReviewReminders("2026-07-02");
    expect(sent).toBe(2); // 两个收件人各一条

    const na = await prisma.notification.findMany({ where: { recipientId: a.id, type: "article_review_reminder" } });
    expect(na).toHaveLength(1);
    const payload = JSON.parse(na[0].payload) as { articleTitle: string; excerpt: string };
    expect(payload.articleTitle).toBe("你有 2 篇文档待优化");
    expect(payload.excerpt).toContain("文档1");
    expect(na[0].dedupeKey).toBe(`review-reminder:${a.id}:2026-07-02`);

    // 同一天再跑 → dedupe,不新增
    expect(await sendReviewReminders("2026-07-02")).toBe(0);
    expect(await prisma.notification.count({ where: { type: "article_review_reminder" } })).toBe(2);
  });

  it("非 issues 状态的文档不提醒", async () => {
    const u = await seedUser({ ssoId: "ou_c" });
    const role = await prisma.role.create({ data: { name: "研发" } });
    await prisma.article.create({ data: { title: "ok", contentMarkdown: "正文", roleId: role.id, createdById: u.id, reviewStatus: "ok" } });
    expect(await sendReviewReminders("2026-07-02")).toBe(0);
  });
});
