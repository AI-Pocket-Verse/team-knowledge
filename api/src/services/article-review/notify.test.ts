import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { resolveLastEditorId, emitReviewNotification, clearReviewNotifications } from "./notify.js";
import type { HashedReviewFinding } from "./findings.js";

const finding = (h: string): HashedReviewFinding => ({ category: "logic", severity: "high", problem: h, suggestion: "", hash: h });

describe("article-review notify", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function setup() {
    const author = await seedUser({ ssoId: "ou_author" });
    const editor = await seedUser({ ssoId: "ou_editor" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({ data: { title: "请假流程", contentMarkdown: "正文", roleId: role.id, createdById: author.id } });
    return { author, editor, role, art };
  }

  it("resolveLastEditorId 取最近带作者版本,回退创建者", async () => {
    const { author, editor, art } = await setup();
    expect(await resolveLastEditorId(art.id)).toBe(author.id); // 无版本 → 创建者
    await prisma.articleVersion.create({ data: { articleId: art.id, title: "请假流程", contentMarkdown: "v", kind: "edit", authorId: editor.id } });
    expect(await resolveLastEditorId(art.id)).toBe(editor.id);
  });

  it("emitReviewNotification 写一条站内通知;同 reviewedHash 不重复", async () => {
    const { editor, art } = await setup();
    await emitReviewNotification({ articleId: art.id, articleTitle: "请假流程", recipientId: editor.id, findings: [finding("a"), finding("b")], reviewedHash: "H1" });
    await emitReviewNotification({ articleId: art.id, articleTitle: "请假流程", recipientId: editor.id, findings: [finding("a")], reviewedHash: "H1" }); // 同 hash → 跳过
    const rows = await prisma.notification.findMany({ where: { recipientId: editor.id, type: "article_review_issue" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(`review:${art.id}:H1`);
    expect(JSON.parse(rows[0].payload).excerpt).toContain("2 处问题");
  });

  it("clearReviewNotifications 把未读 review 通知置已读", async () => {
    const { editor, art } = await setup();
    await emitReviewNotification({ articleId: art.id, articleTitle: "请假流程", recipientId: editor.id, findings: [finding("a")], reviewedHash: "H1" });
    await clearReviewNotifications(art.id);
    const rows = await prisma.notification.findMany({ where: { articleId: art.id, type: "article_review_issue" } });
    expect(rows[0].readAt).not.toBeNull();
  });
});
