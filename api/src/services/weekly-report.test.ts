import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser } from "../../test-helpers/db.js";
import { buildWeeklySnapshot, generateCurrentWeek, getWeeklyReport } from "./weekly-report.js";
import { beijingWeekOf } from "../utils/beijingWeek.js";

// Pick a stable week and stamp every seeded row at its midpoint so events
// always land inside [weekStart, weekEnd) regardless of when the suite runs.
const WEEK = beijingWeekOf(new Date());
const MID = new Date(WEEK.weekStart.getTime() + 3 * 24 * 3600 * 1000);

describe("buildWeeklySnapshot — new scoring", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("weights doc_fix at 3 and buckets it into docEdit (not a new slice)", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "D", contentMarkdown: "x", roleId: role.id, createdById: u.id, createdAt: MID },
    });
    await prisma.articleVersion.create({
      data: { articleId: art.id, title: "D", contentMarkdown: "x", kind: "ai-fix", authorId: u.id, createdAt: MID },
    });

    const snap = await buildWeeklySnapshot(WEEK);
    const row = snap.users.find((r) => r.userId === u.id)!;
    // doc_create (4) + doc_fix (3) = 7
    expect(row.contribution).toBe(7);
    // doc_fix counts as a docEdit in both the row and the overview.
    expect(row.docEdit).toBe(1);
    expect(snap.overview.docEdit).toBe(1);
    // No separate doc_fix slice in the composition.
    expect(snap.composition.some((s) => s.key === "doc_fix")).toBe(false);
  });

  it("scores a document view at 0.2 (weekly report builds view events from ArticleView)", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const viewer = await seedUser({ ssoId: "viewer" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "V", contentMarkdown: "x", roleId: role.id, createdById: owner.id, createdAt: MID },
    });
    // A single view by a non-owner within the week → exactly one view event.
    await prisma.articleView.create({
      data: { articleId: art.id, userId: viewer.id, viewCount: 5, lastViewedAt: MID },
    });

    const snap = await buildWeeklySnapshot(WEEK);
    const row = snap.users.find((r) => r.userId === viewer.id)!;
    // 浏览按 0.2 计(而非默认 1);ArticleView 去重为「用户×文档」一次,与 viewCount 无关。
    expect(row.view).toBe(1);
    expect(row.contribution).toBe(0.2);
  });

  it("scores automation_create (2) and meeting_comment (1)", async () => {
    const u = await seedUser({ ssoId: "u" });
    const host = await seedUser({ ssoId: "host" });
    await prisma.automation.create({
      data: { userId: u.id, name: "简报", prompt: "p", scheduleKind: "once", scheduleConfig: "{}", createdAt: MID },
    });
    const meeting = await prisma.meetingSession.create({
      data: { title: "周会", createdById: host.id, allowedRoleIds: "[]", config: "{}", createdAt: MID },
    });
    await prisma.meetingComment.create({
      data: { sessionId: meeting.id, triggerType: "user_question", triggeredByUserId: u.id, text: "q", atMs: 0, createdAt: MID },
    });

    const snap = await buildWeeklySnapshot(WEEK);
    const row = snap.users.find((r) => r.userId === u.id)!;
    // automation_create (2) + meeting_comment (1) = 3
    expect(row.contribution).toBe(3);
  });

  it("adds the 'received recognition' bonus to an owner's contribution", async () => {
    const owner = await seedUser({ ssoId: "owner" });
    const liker = await seedUser({ ssoId: "liker" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    // Owner authors a doc this week → base contribution 4 (doc_create).
    const art = await prisma.article.create({
      data: { title: "D", contentMarkdown: "x", roleId: role.id, createdById: owner.id, createdAt: MID },
    });
    // Another user likes it → owner gets +0.5 recognition; liker gets +1 (like op).
    await prisma.like.create({ data: { userId: liker.id, articleId: art.id, createdAt: MID } });

    const snap = await buildWeeklySnapshot(WEEK);
    const ownerRow = snap.users.find((r) => r.userId === owner.id)!;
    const likerRow = snap.users.find((r) => r.userId === liker.id)!;
    expect(ownerRow.contribution).toBe(4.5); // 4 (doc_create) + 0.5 (被认可)
    expect(likerRow.contribution).toBe(1); // like op weight, no recognition (self-authored none)
  });
});

describe("周报快照不留私有类事件标题", () => {
  beforeEach(async () => { await resetDb(); await prisma.weeklyReport.deleteMany(); });
  afterAll(async () => { await disconnectDb(); });

  const SECRET = ["SECRET-会议", "SECRET-自动化", "SECRET-上传.xlsx"];

  it("会议 / 自动化 / 上传事件写快照时不带 title，文档事件保留；会议之后改私密也读不到", async () => {
    const u = await seedUser({ ssoId: "u" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "公开文档", contentMarkdown: "x", roleId: role.id, createdById: u.id, createdAt: MID } });
    const meeting = await prisma.meetingSession.create({
      data: { title: SECRET[0], createdById: u.id, allowedRoleIds: "[]", config: "{}", createdAt: MID },
    });
    await prisma.automation.create({
      data: { userId: u.id, name: SECRET[1], prompt: "p", scheduleKind: "once", scheduleConfig: "{}", createdAt: MID },
    });
    await prisma.upload.create({
      data: { filename: "f.bin", originalName: SECRET[2], mimeType: "application/octet-stream", bytes: 1, uploadedById: u.id, createdAt: MID },
    });

    const r = await generateCurrentWeek(new Date(), { regenerate: true });
    await prisma.meetingSession.update({ where: { id: meeting.id }, data: { visibility: "private" } });
    const detail = await getWeeklyReport(r.id);
    const live = detail!.snapshot.liveActivity;
    expect(live.map((i) => i.type).sort()).toEqual(["automation_create", "doc_create", "meeting", "upload"]);
    expect(JSON.stringify(detail)).not.toMatch(/SECRET/);
    expect(live.find((i) => i.type === "doc_create")!.title).toBe("公开文档");
  });

  it("读取时也剥掉已存旧快照里的这三类 title", async () => {
    const snap = {
      weekKey: "2026-01-05", weekStart: "x", weekEnd: "y", weekLabel: "l",
      liveActivity: [
        { at: "t", name: "n", type: "meeting", label: "会议", title: SECRET[0] },
        { at: "t", name: "n", type: "automation_create", label: "a", title: SECRET[1] },
        { at: "t", name: "n", type: "upload", label: "u", title: SECRET[2] },
        { at: "t", name: "n", type: "doc_create", label: "d", title: "文档" },
      ],
    };
    const rec = await prisma.weeklyReport.create({
      data: { weekKey: "2026-01-05", weekStart: new Date(0), weekEnd: new Date(1), snapshot: JSON.stringify(snap) },
    });
    const detail = await getWeeklyReport(rec.id);
    expect(JSON.stringify(detail)).not.toMatch(/SECRET/);
    expect(detail!.snapshot.liveActivity[3].title).toBe("文档");
  });
});
