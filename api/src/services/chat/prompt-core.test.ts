import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { prepareGeneralPrompt } from "./prompt-core.js";

describe("prepareGeneralPrompt", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("KB 命中 → citations(source:doc, ref=articleId);summary 注入 system", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    const out = await prepareGeneralPrompt({
      userId: "system", isAdmin: true, question: "登录改造",
      resolvedMentions: { hits: [], snapshot: [], skillBlocks: [] },
      history: [], summary: "此前聊过登录。",
    });
    expect(out.systemPrompt).toContain("此前聊过登录。");
    expect(out.citations.some((c) => c.source === "doc" && c.title === "登录改造方案")).toBe(true);
    expect(out.userMessage).toBe("登录改造");
  });

  it("@引用命中并入检索;无命中时 citations 为空", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a = await prisma.article.create({ data: { title: "引用文档Y", contentMarkdown: "Y内容", roleId: role.id } });
    const out = await prepareGeneralPrompt({
      userId: "system", isAdmin: true, question: "无关问题zzz",
      resolvedMentions: {
        hits: [{ articleId: a.id, title: "引用文档Y", snippet: "", body: "Y内容", folderId: "", roleId: role.id, folderName: "产品", roleName: "产品" }],
        snapshot: [{ type: "doc", id: a.id, label: "引用文档Y" }], skillBlocks: [],
      },
      history: [],
    });
    expect(out.citations.some((c) => c.ref === a.id)).toBe(true);
  });

  it("有 @引用时,出处只列被引用的文档,不混入 FTS 顺带召回的其它文档", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const target = await prisma.article.create({ data: { title: "APP 接入三方 SDK 调研", contentMarkdown: "登录/推送/支付选型。", roleId: role.id } });
    // 另一篇正文含「SDK」关键词,FTS 会顺带命中,但用户没 @ 它 → 不应出现在出处里。
    await prisma.article.create({ data: { title: "Assistant_隐私政策", contentMarkdown: "需要在隐私政策里说明各 SDK 的数据收集。", roleId: role.id } });
    const out = await prepareGeneralPrompt({
      userId: "system", isAdmin: true,
      question: "@APP 接入三方 SDK 调研 这篇讲了啥",
      resolvedMentions: {
        hits: [{ articleId: target.id, title: "APP 接入三方 SDK 调研", snippet: "", body: "登录/推送/支付选型。", folderId: "", roleId: role.id, folderName: "产品", roleName: "产品" }],
        snapshot: [{ type: "doc", id: target.id, label: "APP 接入三方 SDK 调研" }], skillBlocks: [],
      },
      history: [],
    });
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]!.ref).toBe(target.id);
    expect(out.citations.some((c) => c.title === "Assistant_隐私政策")).toBe(false);
  });
});
