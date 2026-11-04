import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { recordAnswer } from "../group-qa/store.js";
import { searchCrossModule, queryTokens } from "./crossModule.js";

describe("retrieval/crossModule", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("queryTokens:中英文切词,长度<2 过滤,切不出用整串", () => {
    expect(queryTokens("登录改造,免密 30")).toEqual(["登录改造", "免密", "30"]);
    expect(queryTokens("a")).toEqual(["a"]); // 切不出有效 token → 整串
  });

  it("命中会议纪要 + 群答疑,带 source 标签;不命中 → []", async () => {
    const u = await seedUser({ ssoId: "ou_a" });
    await prisma.meetingSession.create({
      data: { title: "研发周会", createdById: u.id, allowedRoleIds: "[]", config: "{}", summaryMarkdown: "讨论了登录改造方案的要点与排期。" },
    });
    await recordAnswer({ chatId: "oc1", chatName: "研发群", question: "登录怎么做免密?", sourceTitle: "登录PRD", hash: "h1", at: Date.now() });

    const hits = await searchCrossModule("登录");
    const sources = hits.map((h) => h.source);
    expect(sources).toContain("meeting");
    expect(sources).toContain("group-qa");
    expect(hits.find((h) => h.source === "meeting")!.ref).toBeTruthy();

    expect(await searchCrossModule("无关词zzz无关词")).toEqual([]);
  });

  // 结果会进任意成员的助手上下文，回答还可能发到飞书群，所以私密会议一律不参与检索。
  it("私密会议的纪要不参与检索", async () => {
    const u = await seedUser({ ssoId: "ou_a" });
    await prisma.meetingSession.create({
      data: { title: "薪酬评审", createdById: u.id, allowedRoleIds: "[]", config: "{}", visibility: "private", summaryMarkdown: "调薪方案定稿。" },
    });
    await prisma.meetingSession.create({
      data: { title: "公开周会", createdById: u.id, allowedRoleIds: "[]", config: "{}", summaryMarkdown: "调薪流程说明。" },
    });
    const hits = await searchCrossModule("调薪");
    expect(hits.map((h) => h.title)).toEqual(["公开周会"]);
  });
});
