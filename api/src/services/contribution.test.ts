import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser } from "../../test-helpers/db.js";
import {
  CONTRIBUTION_WEIGHTS,
  eventWeight,
  RECEIVED_UNIT,
  RECEIVED_WEEKLY_CAP,
  receivedRecognition,
} from "./contribution.js";

describe("eventWeight / CONTRIBUTION_WEIGHTS", () => {
  it("returns the exact configured weight for each known type", () => {
    expect(eventWeight("doc_create")).toBe(4);
    expect(eventWeight("doc_fix")).toBe(3);
    expect(eventWeight("doc_edit")).toBe(3);
    expect(eventWeight("meeting")).toBe(3);
    expect(eventWeight("chat")).toBe(3);
    expect(eventWeight("comment")).toBe(2);
    expect(eventWeight("doc_restore")).toBe(2);
    expect(eventWeight("automation_create")).toBe(2);
    expect(eventWeight("meeting_comment")).toBe(1);
    expect(eventWeight("folder_create")).toBe(1);
    expect(eventWeight("editor_grant")).toBe(0.5);
    expect(eventWeight("like")).toBe(1);
    expect(eventWeight("bookmark")).toBe(1);
    expect(eventWeight("upload")).toBe(1);
    expect(eventWeight("doc_archive")).toBe(1);
    expect(eventWeight("doc_unarchive")).toBe(1);
    expect(eventWeight("comment_like")).toBe(0.5);
    // view 权重必须保留:周报(weekly-report)会构造 view 事件并按此计分。
    expect(eventWeight("view")).toBe(0.2);
  });

  it("defaults unknown types to 1", () => {
    expect(eventWeight("something_new")).toBe(1);
    expect(eventWeight("")).toBe(1);
  });

  it("keeps the exported constants stable", () => {
    expect(CONTRIBUTION_WEIGHTS.doc_create).toBe(4);
    expect(RECEIVED_UNIT).toBe(0.5);
    expect(RECEIVED_WEEKLY_CAP).toBe(10);
  });
});

describe("receivedRecognition", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  const WINDOW = new Date("2026-06-01T00:00:00.000Z");
  const WINDOW_END = new Date("2026-06-08T00:00:00.000Z"); // 左闭右开 [WINDOW, WINDOW_END)
  const inWindow = new Date("2026-06-03T00:00:00.000Z");
  const beforeWindow = new Date("2026-05-20T00:00:00.000Z");
  const afterWindow = new Date("2026-06-15T00:00:00.000Z"); // 窗口结束之后

  it("credits an article owner for likes + bookmarks from OTHERS, excluding self", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const liker = await seedUser({ ssoId: "liker" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "D", contentMarkdown: "x", roleId: role.id, createdById: owner.id },
    });
    // Other user likes + bookmarks → 2 recognitions.
    await prisma.like.create({ data: { userId: liker.id, articleId: art.id, createdAt: inWindow } });
    await prisma.bookmark.create({ data: { userId: liker.id, articleId: art.id, createdAt: inWindow } });
    // Owner self-likes → excluded.
    await prisma.like.create({ data: { userId: owner.id, articleId: art.id, createdAt: inWindow } });

    const map = await receivedRecognition(WINDOW, WINDOW_END, RECEIVED_WEEKLY_CAP);
    expect(map.get(owner.id)).toBe(2 * RECEIVED_UNIT); // 1.0
    expect(map.has(liker.id)).toBe(false);
  });

  it("credits a comment author for comment-likes from others, excluding self", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const other = await seedUser({ ssoId: "other" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "D", contentMarkdown: "x", roleId: role.id, createdById: owner.id },
    });
    const comment = await prisma.comment.create({
      data: { articleId: art.id, authorId: owner.id, body: "hi" },
    });
    await prisma.commentLike.create({ data: { userId: other.id, commentId: comment.id, createdAt: inWindow } });
    // self comment-like excluded
    await prisma.commentLike.create({ data: { userId: owner.id, commentId: comment.id, createdAt: inWindow } });

    const map = await receivedRecognition(WINDOW, WINDOW_END, RECEIVED_WEEKLY_CAP);
    expect(map.get(owner.id)).toBe(1 * RECEIVED_UNIT); // 0.5
  });

  it("caps the bonus at `cap`", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    // 30 distinct likers each like the owner's doc → 30 * 0.5 = 15, capped at 10.
    const arts = [];
    for (let i = 0; i < 30; i++) {
      const art = await prisma.article.create({
        data: { title: `D${i}`, contentMarkdown: "x", roleId: role.id, createdById: owner.id },
      });
      arts.push(art);
      const liker = await seedUser({ ssoId: `liker-${i}` });
      await prisma.like.create({ data: { userId: liker.id, articleId: art.id, createdAt: inWindow } });
    }
    const map = await receivedRecognition(WINDOW, WINDOW_END, RECEIVED_WEEKLY_CAP);
    expect(map.get(owner.id)).toBe(RECEIVED_WEEKLY_CAP); // 10, not 15
  });

  it("excludes likes on soft-deleted articles and likes before/after the window", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const liker = await seedUser({ ssoId: "liker" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const live = await prisma.article.create({
      data: { title: "live", contentMarkdown: "x", roleId: role.id, createdById: owner.id },
    });
    const deleted = await prisma.article.create({
      data: { title: "gone", contentMarkdown: "x", roleId: role.id, createdById: owner.id, deletedAt: new Date() },
    });
    // Like PK is (userId, articleId), so each like below is on a distinct doc.
    const live2 = await prisma.article.create({
      data: { title: "live2", contentMarkdown: "x", roleId: role.id, createdById: owner.id },
    });
    const live3 = await prisma.article.create({
      data: { title: "live3", contentMarkdown: "x", roleId: role.id, createdById: owner.id },
    });
    await prisma.like.create({ data: { userId: liker.id, articleId: live.id, createdAt: inWindow } }); // counted
    await prisma.like.create({ data: { userId: liker.id, articleId: deleted.id, createdAt: inWindow } }); // deleted → excluded
    await prisma.like.create({ data: { userId: liker.id, articleId: live2.id, createdAt: beforeWindow } }); // 早于窗口 → excluded
    await prisma.like.create({ data: { userId: liker.id, articleId: live3.id, createdAt: afterWindow } }); // 晚于窗口 → excluded(上界保证:重算历史周报不漏进未来点赞)

    const map = await receivedRecognition(WINDOW, WINDOW_END, RECEIVED_WEEKLY_CAP);
    expect(map.get(owner.id)).toBe(1 * RECEIVED_UNIT); // only the single in-window live like
  });
});
