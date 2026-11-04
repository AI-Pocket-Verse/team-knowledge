import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../llm/registry.js", () => ({ getProvider: async () => ({ chat }) }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { selectAuditableArticles, capPerCategory, runDocAudit } from "./run.js";
import { getLastCard, setLastCard } from "./acks.js";
import { invalidateAssistantExclusionCache } from "../assistant-filter/exclusions.js";

describe("capPerCategory", () => {
  const mk = (category: string, id: number) => ({ category, id });

  it("每类超过 n 条时被截断,少于不动,保持顺序", () => {
    const findings = [
      mk("logic", 1), mk("logic", 2), mk("logic", 3),
      mk("optimize", 4),
      mk("inconsistency", 5), mk("inconsistency", 6),
    ];
    const out = capPerCategory(findings, 2);
    // logic 截到 2 条(保留前两条),optimize 只有 1 条不动,inconsistency 恰好 2 条不动。
    expect(out.map((f) => f.id)).toEqual([1, 2, 4, 5, 6]);
  });

  it("n 足够大时原样返回(顺序不变)", () => {
    const findings = [mk("logic", 1), mk("optimize", 2), mk("logic", 3)];
    expect(capPerCategory(findings, 10).map((f) => f.id)).toEqual([1, 2, 3]);
  });
});

describe("selectAuditableArticles honors exclusions", () => {
  beforeEach(async () => { await resetDb(); invalidateAssistantExclusionCache(); });
  afterAll(async () => { await disconnectDb(); });

  it("skips an excluded article", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "保留", contentMarkdown: "这是一段足够长的测试正文一", roleId: role.id } });
    const drop = await prisma.article.create({ data: { title: "排除", contentMarkdown: "这是一段足够长的测试正文二", roleId: role.id } });
    await prisma.assistantExclusion.create({ data: { targetType: "article", targetId: drop.id, createdById: "a" } });
    invalidateAssistantExclusionCache();
    const arts = await selectAuditableArticles();
    expect(arts.map((a) => a.title)).toEqual(["保留"]);
  });

  it("skips every article under an excluded role", async () => {
    const keepRole = await prisma.role.create({ data: { name: "工程" } });
    const dropRole = await prisma.role.create({ data: { name: "法务" } });
    await prisma.article.create({ data: { title: "工程文档", contentMarkdown: "这是一段足够长的测试正文一", roleId: keepRole.id } });
    await prisma.article.create({ data: { title: "法务文档", contentMarkdown: "这是一段足够长的测试正文二", roleId: dropRole.id } });
    await prisma.assistantExclusion.create({ data: { targetType: "role", targetId: dropRole.id, createdById: "a" } });
    invalidateAssistantExclusionCache();
    const arts = await selectAuditableArticles();
    expect(arts.map((a) => a.title)).toEqual(["工程文档"]);
  });

  it("skips docs in an excluded folder and its subfolder, keeps role-direct ones", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const parent = await prisma.folder.create({ data: { name: "父", roleId: role.id, visibility: "public" } });
    const child = await prisma.folder.create({ data: { name: "子", roleId: role.id, visibility: "public", parentId: parent.id } });
    await prisma.article.create({ data: { title: "父目录文档", contentMarkdown: "这是一段足够长的测试正文一", roleId: role.id, folderId: parent.id } });
    await prisma.article.create({ data: { title: "子目录文档", contentMarkdown: "这是一段足够长的测试正文二", roleId: role.id, folderId: child.id } });
    await prisma.article.create({ data: { title: "角色直属保留", contentMarkdown: "这是一段足够长的测试正文三", roleId: role.id } });
    await prisma.assistantExclusion.create({ data: { targetType: "folder", targetId: parent.id, createdById: "a" } });
    invalidateAssistantExclusionCache();
    const arts = await selectAuditableArticles();
    // 父目录 + 其子目录的文档都被排除(子文件夹级联);角色直属文档保留。
    expect(arts.map((a) => a.title)).toEqual(["角色直属保留"]);
  });
});

describe("runDocAudit 与 last_card", () => {
  beforeEach(async () => { await resetDb(); invalidateAssistantExclusionCache(); chat.mockReset(); });

  const seedDoc = async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "文档", contentMarkdown: "这是一段足够长的测试正文一", roleId: role.id } });
  };
  const prev = [{ id: 1, category: "logic", hash: "h-prev" }] as never;

  it("所有批次都失败(LLM 报错):不覆盖上一张真实体检卡的 last_card", async () => {
    await seedDoc();
    await setLastCard(prev);
    chat.mockImplementation(async function* () { yield { type: "error", message: "boom" }; });
    await runDocAudit(new Date());
    expect(await getLastCard()).toEqual(prev);
  });

  it("persist=false(通知测试):即使跑成功也不覆盖 last_card", async () => {
    await seedDoc();
    await setLastCard(prev);
    chat.mockImplementation(async function* () { yield { type: "token", text: "[]" }; });
    await runDocAudit(new Date(), { persist: false });
    expect(await getLastCard()).toEqual(prev);
  });

  it("至少一批成功:写入本次结果", async () => {
    await seedDoc();
    await setLastCard(prev);
    chat.mockImplementation(async function* () { yield { type: "token", text: "[]" }; });
    await runDocAudit(new Date());
    expect(await getLastCard()).toEqual([]);
  });
});
