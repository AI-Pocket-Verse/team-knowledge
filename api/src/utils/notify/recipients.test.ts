import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { resolveRecipients } from "./recipients.js";

function makeArticle(roleId: string, createdById: string) {
  return prisma.article.create({
    data: { title: "T", contentMarkdown: "x", roleId, createdById, sortOrder: 0 },
  });
}

describe("resolveRecipients", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("article_like → author + role members, minus the actor", async () => {
    const author = await seedUser({ ssoId: "author" });
    const member = await seedUser({ ssoId: "member" });
    const actor = await seedUser({ ssoId: "actor" });
    const role = await prisma.role.create({ data: { name: "R" } });
    // member + actor are role members; author is NOT.
    await prisma.userRole.createMany({
      data: [
        { userId: member.id, roleId: role.id },
        { userId: actor.id, roleId: role.id },
      ],
    });
    const article = await makeArticle(role.id, author.id);

    const map = await resolveRecipients({ type: "article_like", articleId: article.id, actorId: actor.id });
    expect(new Set(map.keys())).toEqual(new Set([author.id, member.id]));
    expect(map.get(author.id)).toBe("article_like");
    expect(map.get(member.id)).toBe("article_like");
    expect(map.has(actor.id)).toBe(false); // self-action excluded
  });

  it("includeSelf keeps the actor in the set (NOTIFY_INCLUDE_SELF dev flag)", async () => {
    const author = await seedUser({ ssoId: "author" });
    const role = await prisma.role.create({ data: { name: "R" } });
    await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
    const article = await makeArticle(role.id, author.id);
    // author likes their OWN article — normally excluded, kept with includeSelf
    const map = await resolveRecipients(
      { type: "article_like", articleId: article.id, actorId: author.id },
      { includeSelf: true },
    );
    expect(map.get(author.id)).toBe("article_like");
  });

  it("article_comment → adds prior participants + @mentioned with the right framing", async () => {
    const author = await seedUser({ ssoId: "author" });
    const participant = await seedUser({ ssoId: "participant" });
    const mentioned = await seedUser({ ssoId: "mentioned" });
    const actor = await seedUser({ ssoId: "actor" });
    const role = await prisma.role.create({ data: { name: "R" } });
    const article = await makeArticle(role.id, author.id);
    await prisma.comment.create({ data: { articleId: article.id, authorId: participant.id, body: "hi" } });

    const map = await resolveRecipients({
      type: "article_comment", articleId: article.id, actorId: actor.id,
      mentionedUserIds: [mentioned.id],
    });
    expect(map.get(author.id)).toBe("article_comment");
    expect(map.get(participant.id)).toBe("article_comment");
    expect(map.get(mentioned.id)).toBe("comment_mention"); // mention wins over plain comment
  });

  it("comment_reply → the replied-to comment author gets comment_reply framing", async () => {
    const author = await seedUser({ ssoId: "author" });
    const parentAuthor = await seedUser({ ssoId: "parent" });
    const actor = await seedUser({ ssoId: "actor" });
    const role = await prisma.role.create({ data: { name: "R" } });
    const article = await makeArticle(role.id, author.id);
    await prisma.comment.create({ data: { articleId: article.id, authorId: parentAuthor.id, body: "top" } });

    const map = await resolveRecipients({
      type: "comment_reply", articleId: article.id, actorId: actor.id, parentAuthorId: parentAuthor.id,
    });
    expect(map.get(parentAuthor.id)).toBe("comment_reply");
    expect(map.get(author.id)).toBe("article_comment");
  });

  it("已停用成员不进收件人(即便仍在角色里或评论过)", async () => {
    const author = await seedUser({ ssoId: "author" });
    const gone = await seedUser({ ssoId: "gone", isActive: false });
    const actor = await seedUser({ ssoId: "actor" });
    const role = await prisma.role.create({ data: { name: "R" } });
    await prisma.userRole.create({ data: { userId: gone.id, roleId: role.id } });
    const article = await makeArticle(role.id, author.id);
    await prisma.comment.create({ data: { articleId: article.id, authorId: gone.id, body: "hi" } });

    const map = await resolveRecipients({
      type: "article_comment", articleId: article.id, actorId: actor.id, mentionedUserIds: [gone.id],
    });
    expect(map.has(gone.id)).toBe(false);
    expect(map.has(author.id)).toBe(true);
  });
});
