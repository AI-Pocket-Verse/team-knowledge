import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// emit triggers a dispatch pass; stub it so this test only exercises row-writing
// (no async Feishu send racing the assertions). Dispatch is tested separately.
vi.mock("./dispatcher.js", () => ({ kickDispatch: vi.fn(async () => {}), startDispatcher: vi.fn() }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { emitNotification } from "./service.js";

function makeArticle(roleId: string, createdById: string) {
  return prisma.article.create({
    data: { title: "T", contentMarkdown: "x", roleId, createdById, sortOrder: 0 },
  });
}

async function setup() {
  const author = await seedUser({ ssoId: "author" });
  const member = await seedUser({ ssoId: "member" });
  const actor = await seedUser({ ssoId: "actor" });
  const role = await prisma.role.create({ data: { name: "R" } });
  await prisma.userRole.createMany({
    data: [
      { userId: member.id, roleId: role.id },
      { userId: actor.id, roleId: role.id },
    ],
  });
  const article = await makeArticle(role.id, author.id);
  return { author, member, actor, article };
}

describe("emitNotification", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("writes one pending row per recipient (author + members), excluding the actor", async () => {
    const { author, member, actor, article } = await setup();
    await emitNotification({ type: "article_like", articleId: article.id, actorId: actor.id });

    const rows = await prisma.notification.findMany({});
    expect(rows.length).toBe(2);
    const byRecipient = new Map(rows.map((r) => [r.recipientId, r]));
    expect(byRecipient.has(actor.id)).toBe(false);
    expect(rows.every((r) => r.type === "article_like")).toBe(true);
    expect(rows.every((r) => r.feishuState === "pending")).toBe(true);
    expect(JSON.parse(byRecipient.get(author.id)!.payload)).toMatchObject({ actorName: "actor", articleTitle: "T" });
  });

  it("dedupes the same (recipient, type, article, actor) within the window", async () => {
    const { actor, article } = await setup();
    await emitNotification({ type: "article_like", articleId: article.id, actorId: actor.id });
    await emitNotification({ type: "article_like", articleId: article.id, actorId: actor.id });
    expect(await prisma.notification.count()).toBe(2); // not 4
  });

  it("does NOT dedupe two distinct comments by the same actor (keyed on commentId)", async () => {
    const { author, actor, article } = await setup();
    const c1 = await prisma.comment.create({ data: { articleId: article.id, authorId: actor.id, body: "one" } });
    const c2 = await prisma.comment.create({ data: { articleId: article.id, authorId: actor.id, body: "two" } });
    await emitNotification({ type: "article_comment", articleId: article.id, actorId: actor.id, commentId: c1.id });
    await emitNotification({ type: "article_comment", articleId: article.id, actorId: actor.id, commentId: c2.id });
    const authorRows = await prisma.notification.findMany({ where: { recipientId: author.id, type: "article_comment" } });
    expect(authorRows.length).toBe(2); // one per distinct comment, not collapsed
    expect(new Set(authorRows.map((r) => r.commentId))).toEqual(new Set([c1.id, c2.id]));
  });

  it("a muted type is suppressed entirely (no in-app row)", async () => {
    const { author, member, actor, article } = await setup();
    await prisma.notificationPref.create({ data: { userId: member.id, muteLikes: true } });
    await emitNotification({ type: "article_like", articleId: article.id, actorId: actor.id });

    expect(await prisma.notification.findFirst({ where: { recipientId: member.id } })).toBeNull();
    const authorRow = await prisma.notification.findFirst({ where: { recipientId: author.id } });
    expect(authorRow?.feishuState).toBe("pending");
  });

  it("feishuEnabled=false keeps the in-app row but skips the Feishu push", async () => {
    const { member, actor, article } = await setup();
    await prisma.notificationPref.create({ data: { userId: member.id, feishuEnabled: false } });
    await emitNotification({ type: "article_like", articleId: article.id, actorId: actor.id });

    const memberRow = await prisma.notification.findFirst({ where: { recipientId: member.id } });
    expect(memberRow?.feishuState).toBe("skipped");
  });
});
