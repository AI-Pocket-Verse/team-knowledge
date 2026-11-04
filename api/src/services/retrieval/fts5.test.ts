import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { search, tokenizeQuery } from "./fts5.js";
import { invalidateAssistantExclusionCache } from "../assistant-filter/exclusions.js";

async function makePublic(roleName: string, modName: string) {
  const role = await prisma.role.create({ data: { name: roleName } });
  const mod = await prisma.folder.create({ data: { name: modName, roleId: role.id, visibility: "public" } });
  return { role, mod };
}

async function makePrivate(roleName: string, modName: string) {
  const role = await prisma.role.create({ data: { name: roleName } });
  const mod = await prisma.folder.create({ data: { name: modName, roleId: role.id, visibility: "private" } });
  return { role, mod };
}

async function pubArticle(mod: { id: string; roleId: string }, title: string, body: string) {
  return prisma.article.create({ data: { title, contentMarkdown: body, folderId: mod.id, roleId: mod.roleId } });
}

describe("fts5 search", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("matches a published article by title", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const { mod } = await makePublic("产品", "PRD");
    await pubArticle(mod, "V2.3 接入方案", "签名校验 错误码");
    const hits = await search({ query: "接入方案", userId: u.id, isAdmin: false, limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("V2.3 接入方案");
  });

  it("includes articles from any folder (every doc is searchable)", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const { mod } = await makePrivate("secret", "M");
    await pubArticle(mod, "Hidden 接入方案", "x");
    // Folders have no public/private gate anymore — a non-member still finds it.
    const hits = await search({ query: "接入方案", userId: u.id, isAdmin: false, limit: 5 });
    expect(hits.map((h) => h.title)).toEqual(["Hidden 接入方案"]);
  });

  it("includes private-folder articles when user has the role", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const { role, mod } = await makePrivate("secret", "M");
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    await pubArticle(mod, "Member 接入方案", "x");
    const hits = await search({ query: "接入方案", userId: u.id, isAdmin: false, limit: 5 });
    expect(hits.map((h) => h.title)).toEqual(["Member 接入方案"]);
  });

  it("admin sees everything", async () => {
    const u = await prisma.user.create({ data: { ssoId: "a", displayName: "A", isAdmin: true } });
    const { mod } = await makePrivate("secret", "M");
    await pubArticle(mod, "Admin 接入方案", "x");
    const hits = await search({ query: "接入方案", userId: u.id, isAdmin: true, limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it("malformed query returns [] (no throw)", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    expect(await search({ query: '"""', userId: u.id, isAdmin: false, limit: 5 })).toEqual([]);
    expect(await search({ query: "", userId: u.id, isAdmin: false, limit: 5 })).toEqual([]);
  });

  // Regression: a paragraph-length user question used to be wrapped as
  // one FTS5 quoted phrase, which required the entire sentence to
  // appear as a literal substring in the doc — i.e. always 0 hits.
  // The tokenizer now slices the question into content phrases and
  // OR-matches them.
  // Regression: query "隐私协议" should still pull a doc titled
  // "Assistant_隐私政策". The two phrases share the bigram "隐私" but no
  // trigram — trigram-only FTS5 silently returned 0 hits, which is
  // exactly the "AI says it can't find the doc" symptom users hit.
  it("bridges synonym/vocabulary mismatch via 2-char fragments (协议 ↔ 政策)", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const { mod } = await makePublic("法务", "合规");
    await pubArticle(mod, "Assistant_隐私政策", "1.1 账号与身份信息\n手机号、账号ID、昵称。");
    const hits = await search({
      query: "结合现有文档,分析一下现在产品的隐私协议是否有问题",
      userId: u.id, isAdmin: false, limit: 5,
    });
    expect(hits.map((h) => h.title)).toContain("Assistant_隐私政策");
  });

  // The original-phrase match should outrank pure 2-char fragment matches.
  it("ranks docs containing the exact long phrase above docs that only match short fragments", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: true } });
    const { mod } = await makePublic("法务", "合规");
    await pubArticle(mod, "其他规章", "正文随便提了下'隐私'两字。");          // 2-char fragment only
    await pubArticle(mod, "隐私协议详细说明", "完整内容...");                  // exact 4-char phrase in title
    const hits = await search({ query: "隐私协议", userId: u.id, isAdmin: true, limit: 5 });
    expect(hits[0]?.title).toBe("隐私协议详细说明");
  });

  // Regression: a latin greeting ("hello") must NOT drag in unrelated CJK docs.
  // The bigram expansion used to split "hello" into "he"/"lo", which `LIKE %he%`
  // matches inside almost any English doc body — surfacing irrelevant 出处 chips
  // (反例:问 "hello" 引到《APP 接入三方 SDK 调研》). Latin words now match whole-word only.
  it("latin greeting does not pull unrelated docs via 2-char fragments", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: true } });
    const { mod } = await makePublic("研发", "技术");
    await pubArticle(mod, "APP 接入三方 SDK 调研", "We evaluated several vendors below; here are the headers.");
    const hits = await search({ query: "hello", userId: u.id, isAdmin: true, limit: 5 });
    expect(hits).toEqual([]);
  });

  // The scan is now a bounded two-stage query (candidate CTE capped by
  // CANDIDATE_CAP, then score/order over the bounded set). With many matching
  // rows the title-weighted top hit must still rank first and the LIMIT must
  // still bound the output — i.e. the bound didn't break ranking.
  it("ranks the title hit first and respects the output limit across many body matches (bounded scan)", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: true } });
    const { mod } = await makePublic("产品", "PRD");
    // 30 docs that match "接入" only in the BODY (low weight)...
    for (let i = 0; i < 30; i++) {
      await pubArticle(mod, `正文命中${i}`, "这里提到接入流程的细节");
    }
    // ...and one doc that matches "接入" in the TITLE (high weight).
    await pubArticle(mod, "接入方案总览", "正文随意");
    const hits = await search({ query: "接入", userId: u.id, isAdmin: true, limit: 5 });
    expect(hits).toHaveLength(5);            // LIMIT honored
    expect(hits[0]!.title).toBe("接入方案总览"); // title weight wins
  });

  it("recovers content terms from a long natural-language question", async () => {
    const u = await prisma.user.create({ data: { ssoId: "u", displayName: "U", isAdmin: false } });
    const { mod } = await makePublic("法务", "合规");
    await pubArticle(mod, "隐私协议草案 v1", "本协议适用于...");
    const hits = await search({
      query: "结合现有文档,分析一下现在产品的隐私协议是否有问题",
      userId: u.id, isAdmin: false, limit: 5,
    });
    expect(hits.map((h) => h.title)).toContain("隐私协议草案 v1");
  });
});

describe("search() honors AI exclusions", () => {
  beforeEach(async () => { await resetDb(); invalidateAssistantExclusionCache(); });
  afterAll(async () => { await disconnectDb(); });

  async function pub(title: string, body: string, roleId: string, folderId: string | null = null) {
    return prisma.article.create({ data: { title, contentMarkdown: body, roleId, folderId } });
  }

  it("drops an article whose role is excluded", async () => {
    const role = await prisma.role.create({ data: { name: "法务" } });
    await pub("隐私协议说明", "隐私协议 用户数据", role.id);
    // 未排除时能搜到
    expect((await search({ query: "隐私协议", userId: "", isAdmin: false })).length).toBe(1);
    // 排除该角色后搜不到
    await prisma.assistantExclusion.create({ data: { targetType: "role", targetId: role.id, createdById: "a" } });
    invalidateAssistantExclusionCache();
    expect((await search({ query: "隐私协议", userId: "", isAdmin: false })).length).toBe(0);
  });

  it("drops an article in an excluded folder and its subfolder", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const parent = await prisma.folder.create({ data: { name: "父", roleId: role.id, visibility: "public" } });
    const child = await prisma.folder.create({ data: { name: "子", roleId: role.id, visibility: "public", parentId: parent.id } });
    await pub("规范文档甲", "接入规范 甲", role.id, child.id);
    await prisma.assistantExclusion.create({ data: { targetType: "folder", targetId: parent.id, createdById: "a" } });
    invalidateAssistantExclusionCache();
    expect((await search({ query: "接入规范", userId: "", isAdmin: false })).length).toBe(0);
  });

  it("drops a single excluded article but keeps siblings", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const bad = await pub("方案旧版", "支付方案 旧", role.id);
    await pub("方案新版", "支付方案 新", role.id);
    await prisma.assistantExclusion.create({ data: { targetType: "article", targetId: bad.id, createdById: "a" } });
    invalidateAssistantExclusionCache();
    const hits = await search({ query: "支付方案", userId: "", isAdmin: false });
    expect(hits.map((h) => h.title)).toEqual(["方案新版"]);
  });
});

describe("tokenizeQuery", () => {
  it("returns [] for empty / whitespace-only input", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });

  it("keeps a short single-keyword query intact", () => {
    expect(tokenizeQuery("接入方案")).toEqual(["接入方案"]);
  });

  it("slices a long question into content phrases", () => {
    const out = tokenizeQuery("结合现有文档,分析一下现在产品的隐私协议是否有问题");
    expect(out).toContain("隐私协议");
    // Stopwords ("结合","分析","一下","现在","的","是否","问题") must NOT survive.
    expect(out).not.toContain("结合");
    expect(out).not.toContain("分析");
    expect(out).not.toContain("一下");
    expect(out).not.toContain("现在");
    expect(out).not.toContain("是否");
    expect(out).not.toContain("问题");
  });

  it("orders longer (more specific) phrases first", () => {
    const out = tokenizeQuery("隐私协议草案 vs 协议");
    // "隐私协议草案" (6) should come before "协议" (2).
    const ai = out.indexOf("隐私协议草案");
    const bi = out.indexOf("协议");
    if (ai !== -1 && bi !== -1) expect(ai).toBeLessThan(bi);
  });

  it("strips ASCII + CJK punctuation as delimiters", () => {
    expect(tokenizeQuery("产品、运营,以及法务")).toEqual(expect.arrayContaining(["产品", "运营", "法务"]));
  });

  it("caps at 8 phrases so a paragraph doesn't blow up the FTS query", () => {
    const longQ = "甲乙 丙丁 戊己 庚辛 壬癸 子丑 寅卯 辰巳 午未 申酉 戌亥";
    expect(tokenizeQuery(longQ).length).toBeLessThanOrEqual(8);
  });
});
