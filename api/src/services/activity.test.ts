import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser } from "../../test-helpers/db.js";
import { loadActivityEvents } from "./activity.js";
import { getPublicActivity } from "./publicProfile.js";

const WINDOW = new Date("2026-06-01T00:00:00.000Z");
const at = new Date("2026-06-03T00:00:00.000Z");

describe("loadActivityEvents — new sources", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("maps an ai-fix article version to doc_fix", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "D", contentMarkdown: "x", roleId: role.id, createdById: u.id },
    });
    await prisma.articleVersion.create({
      data: { articleId: art.id, title: "D", contentMarkdown: "x", kind: "ai-fix", authorId: u.id, createdAt: at },
    });

    const events = await loadActivityEvents(WINDOW);
    const fix = events.find((e) => e.type === "doc_fix");
    expect(fix).toBeTruthy();
    expect(fix!.uid).toBe(u.id);
    expect(fix!.title).toBe("D");
  });

  it("导入产生的版本不算「修改文档」（动态流与公开主页都一样）", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "D", contentMarkdown: "x", roleId: role.id, createdById: u.id, createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.articleVersion.create({
      data: { articleId: art.id, title: "D", contentMarkdown: "x", kind: "import", authorId: u.id, createdAt: at },
    });
    await prisma.articleVersion.create({
      data: { articleId: art.id, title: "D", contentMarkdown: "y", kind: "edit", authorId: u.id, createdAt: at },
    });

    const events = await loadActivityEvents(WINDOW);
    expect(events.filter((e) => e.type === "doc_edit")).toHaveLength(1);

    const pub = await getPublicActivity({ targetId: u.id, targetName: "u", viewer: { id: u.id, isAdmin: false } as never, page: 1 });
    expect(pub.items.filter((i) => i.type === "doc_edit")).toHaveLength(1);
  });

  it("emits comment_like events for comment likes on live docs", async () => {
    const u = await seedUser({ ssoId: "u" });
    const author = await seedUser({ ssoId: "author" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "标题A", contentMarkdown: "x", roleId: role.id, createdById: author.id },
    });
    const comment = await prisma.comment.create({ data: { articleId: art.id, authorId: author.id, body: "hi" } });
    await prisma.commentLike.create({ data: { userId: u.id, commentId: comment.id, createdAt: at } });

    const events = await loadActivityEvents(WINDOW);
    const cl = events.find((e) => e.type === "comment_like");
    expect(cl).toBeTruthy();
    expect(cl!.uid).toBe(u.id);
    expect(cl!.title).toBe("标题A");
  });

  it("emits automation_create events with the automation name as title", async () => {
    const u = await seedUser({ ssoId: "u" });
    await prisma.automation.create({
      data: {
        userId: u.id,
        name: "每日简报",
        prompt: "p",
        scheduleKind: "once",
        scheduleConfig: "{}",
        createdAt: at,
      },
    });

    const events = await loadActivityEvents(WINDOW);
    const a = events.find((e) => e.type === "automation_create");
    expect(a).toBeTruthy();
    expect(a!.uid).toBe(u.id);
    expect(a!.title).toBe("每日简报");
  });

  it("emits meeting_comment events attributed to the triggering user", async () => {
    const host = await seedUser({ ssoId: "host" });
    const asker = await seedUser({ ssoId: "asker" });
    const meeting = await prisma.meetingSession.create({
      data: { title: "周会", createdById: host.id, allowedRoleIds: "[]", config: "{}" },
    });
    await prisma.meetingComment.create({
      data: {
        sessionId: meeting.id,
        triggerType: "user_question",
        triggeredByUserId: asker.id,
        text: "问题?",
        atMs: 0,
        createdAt: at,
      },
    });

    const events = await loadActivityEvents(WINDOW);
    const mc = events.find((e) => e.type === "meeting_comment");
    expect(mc).toBeTruthy();
    expect(mc!.uid).toBe(asker.id);
    expect(mc!.title).toBe("周会");
  });

  it("excludes comment likes on soft-deleted docs and meeting comments on deleted meetings", async () => {
    const u = await seedUser({ ssoId: "u" });
    const host = await seedUser({ ssoId: "host" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const deletedArt = await prisma.article.create({
      data: { title: "gone", contentMarkdown: "x", roleId: role.id, createdById: host.id, deletedAt: new Date() },
    });
    const comment = await prisma.comment.create({ data: { articleId: deletedArt.id, authorId: host.id, body: "hi" } });
    await prisma.commentLike.create({ data: { userId: u.id, commentId: comment.id, createdAt: at } });

    const deletedMeeting = await prisma.meetingSession.create({
      data: { title: "已删", createdById: host.id, allowedRoleIds: "[]", config: "{}", deletedAt: new Date() },
    });
    await prisma.meetingComment.create({
      data: { sessionId: deletedMeeting.id, triggerType: "user_question", triggeredByUserId: u.id, text: "q", atMs: 0, createdAt: at },
    });

    const events = await loadActivityEvents(WINDOW);
    expect(events.some((e) => e.type === "comment_like")).toBe(false);
    expect(events.some((e) => e.type === "meeting_comment")).toBe(false);
  });

  // 私密会议只有创建者能看，管理员也不例外：活动流（管理后台）不出现它的标题与会内发言。
  it("excludes private meetings and their meeting comments", async () => {
    const host = await seedUser({ ssoId: "host" });
    const asker = await seedUser({ ssoId: "asker" });
    const meeting = await prisma.meetingSession.create({
      data: { title: "薪酬评审", createdById: host.id, allowedRoleIds: "[]", config: "{}", visibility: "private", createdAt: at },
    });
    await prisma.meetingComment.create({
      data: { sessionId: meeting.id, triggerType: "user_question", triggeredByUserId: asker.id, text: "q", atMs: 0, createdAt: at },
    });

    const events = await loadActivityEvents(WINDOW);
    expect(events.filter((e) => e.type === "meeting" || e.type === "meeting_comment")).toEqual([]);
  });

  it("emits folder_create events with the folder name as title", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.folder.create({
      data: { name: "接入文档", roleId: role.id, createdById: u.id, createdAt: at },
    });

    const events = await loadActivityEvents(WINDOW);
    const f = events.find((e) => e.type === "folder_create");
    expect(f).toBeTruthy();
    expect(f!.uid).toBe(u.id);
    expect(f!.title).toBe("接入文档");
  });

  it("emits editor_grant attributed to the granter (grantedBy), using grantedAt window", async () => {
    const granter = await seedUser({ ssoId: "granter" });
    const grantee = await seedUser({ ssoId: "grantee" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "共享文档", contentMarkdown: "x", roleId: role.id, createdById: granter.id },
    });
    await prisma.articleEditor.create({
      data: { articleId: art.id, userId: grantee.id, grantedBy: granter.id, grantedAt: at },
    });

    const events = await loadActivityEvents(WINDOW);
    const g = events.find((e) => e.type === "editor_grant");
    expect(g).toBeTruthy();
    expect(g!.uid).toBe(granter.id); // 归属给授权的人
    expect(g!.title).toBe("共享文档");
  });
});
