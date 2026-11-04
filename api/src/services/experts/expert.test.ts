import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { setExpert } from "./config.js";
import { answerAsExpert, buildExpertSystem, newRetrievalCache, fetchCrossModule, fetchKbDocs } from "./expert.js";

describe("experts/expert", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("buildExpertSystem 拼入专家设定 + 本角色 skill + 检索上下文", () => {
    const s = buildExpertSystem({ roleName: "产品", instruction: "你是产品专家", skillMd: "## 专长\n需求梳理", context: ["【文档·X】内容"] });
    expect(s).toContain("你是产品专家");
    expect(s).toContain("需求梳理");
    expect(s).toContain("【文档·X】内容");
  });

  it("组装全库文档检索 + skill,返回答案与出处;webSearch 开 → 传 webTools=true", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.roleSkill.create({ data: { roleId: role.id, content: "## 产品专长\n擅长需求梳理", status: "ready" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "登录改造的核心是免密 30 天。", roleId: role.id } });
    await setExpert(role.id, { sources: { kbDocs: true, crossModule: false, webSearch: true, consult: true } }, "admin");

    let captured: { system: string; webTools: boolean } | null = null;
    const out = await answerAsExpert(role.id, "登录改造", {
      runLlm: async (system, _user, o) => { captured = { system, webTools: o.webTools }; return "建议拆 3 个验收点。"; },
    });

    expect(out?.answer).toBe("建议拆 3 个验收点。");
    expect(out?.citations.some((c) => c.source === "doc" && c.title === "登录改造方案")).toBe(true);
    expect(captured!.webTools).toBe(true);                 // sources.webSearch=true → 放开联网
    expect(captured!.system).toContain("擅长需求梳理");      // 本角色 skill 拼进 system
  });

  it("联网命中(onCitation)并入 citations,source=web、去重;onToken 透传流式", async () => {
    const role = await prisma.role.create({ data: { name: "技术" } });
    await setExpert(role.id, { sources: { kbDocs: false, crossModule: false, webSearch: true, consult: true } }, "admin");

    const tokens: string[] = [];
    const out = await answerAsExpert(role.id, "最新版本", {
      onToken: (t) => tokens.push(t),
      runLlm: async (_s, _u, _o, sinks) => {
        sinks?.onCitation?.({ url: "https://docs.example/v2", title: "V2 发布说明" });
        sinks?.onCitation?.({ url: "https://docs.example/v2", title: "重复" }); // 去重
        sinks?.onToken?.("最");
        sinks?.onToken?.("新");
        return "最新";
      },
    });

    const web = out?.citations.filter((c) => c.source === "web") ?? [];
    expect(web).toEqual([{ source: "web", title: "V2 发布说明", ref: "https://docs.example/v2" }]);
    expect(tokens.join("")).toBe("最新");
  });

  it("RetrievalCache 按 query 记忆:同 query 返回同一结果引用(只查一次),异 query 不共享", async () => {
    const u = await prisma.user.create({ data: { ssoId: "ou_mtg", displayName: "M" } });
    await prisma.meetingSession.create({
      data: { title: "登录改造评审", createdById: u.id, allowedRoleIds: "[]", config: "{}", summaryMarkdown: "结论:免密 30 天。" },
    });
    const cache = newRetrievalCache();
    // 同 query 两次 → 命中缓存,返回的是同一个 Promise 结果(引用相等),证明只算了一次。
    const a = await fetchCrossModule("登录改造", cache);
    const b = await fetchCrossModule("登录改造", cache);
    expect(a).toBe(b);
    expect(a.some((h) => h.title.includes("登录改造"))).toBe(true);
    // 异 query → 另起一次,引用不同。
    const c = await fetchCrossModule("别的问题", cache);
    expect(c).not.toBe(a);
    // 无 cache → 每次都是新结果(不记忆)。
    const d1 = await fetchKbDocs("x", undefined);
    const d2 = await fetchKbDocs("x", undefined);
    expect(d1).not.toBe(d2);
  });

  it("专家拿到 summary + @引用文档 + 图,且 @引用并入出处", async () => {
    const role = await prisma.role.create({ data: { name: "技术" } });
    await setExpert(role.id, { sources: { kbDocs: false, crossModule: false, webSearch: false, consult: true } }, "admin");
    let captured: { system: string; images?: string[] } | null = null;
    const out = await answerAsExpert(role.id, "问", {
      summary: "摘要X",
      mentionHits: [{ articleId: "d1", title: "引用文档Y", body: "Y内容", roleName: "技术", folderName: "f", folderId: "f", roleId: role.id, snippet: "" }],
      images: ["/abs/a.png"],
      runLlm: async (system, _u, o) => { captured = { system, images: o.images }; return "答"; },
    });
    expect(out?.answer).toBe("答");
    expect(captured!.system).toContain("摘要X");
    expect(captured!.system).toContain("引用文档Y");
    expect(captured!.images).toEqual(["/abs/a.png"]);
    expect(out?.citations.some((c) => c.source === "doc" && c.ref === "d1")).toBe(true);
  });

  it("角色不存在 → null;LLM 失败(null)→ null", async () => {
    expect(await answerAsExpert("nope", "x", { runLlm: async () => "y" })).toBeNull();
    const role = await prisma.role.create({ data: { name: "产品" } });
    expect(await answerAsExpert(role.id, "x", { runLlm: async () => null })).toBeNull();
  });

  it("(出处收紧)专家声明 [[USED: none]] → 丢弃检索文档,@引用恒留,标记剥除", async () => {
    const role = await prisma.role.create({ data: { name: "测试" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    await setExpert(role.id, { sources: { kbDocs: true, crossModule: false, webSearch: false, consult: true } }, "admin");
    const out = await answerAsExpert(role.id, "登录改造", {
      mentionHits: [{ articleId: "d1", title: "用户点的文档", body: "Y内容", roleName: "测试", folderName: "f", folderId: "f", roleId: role.id, snippet: "" }],
      runLlm: async () => "随口答。\n[[USED: none]]",
    });
    expect(out?.answer).toBe("随口答。");                       // 隐藏标记被剥除
    expect(out?.citations.map((c) => c.ref)).toEqual(["d1"]);  // 检索到的「登录改造方案」被丢,@引用 d1 恒留
  });

  it("(出处收紧)专家声明 [[USED: #1]] → 只挂被实际引用的那条检索文档", async () => {
    const role = await prisma.role.create({ data: { name: "测试" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    await setExpert(role.id, { sources: { kbDocs: true, crossModule: false, webSearch: false, consult: true } }, "admin");
    const out = await answerAsExpert(role.id, "登录改造", {
      runLlm: async () => "基于方案:免密 30 天。\n[[USED: #1]]",
    });
    expect(out?.answer).toBe("基于方案:免密 30 天。");
    expect(out?.citations.map((c) => c.title)).toEqual(["登录改造方案"]);
  });

  it("(出处收紧)专家没给 [[USED]] 标记 → 回退全列(向后兼容)", async () => {
    const role = await prisma.role.create({ data: { name: "测试" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    await setExpert(role.id, { sources: { kbDocs: true, crossModule: false, webSearch: false, consult: true } }, "admin");
    const out = await answerAsExpert(role.id, "登录改造", { runLlm: async () => "直接作答,无标记。" });
    expect(out?.answer).toBe("直接作答,无标记。");
    expect(out?.citations.some((c) => c.title === "登录改造方案")).toBe(true);
  });
});
