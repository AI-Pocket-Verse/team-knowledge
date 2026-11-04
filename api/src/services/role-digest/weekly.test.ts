import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { computeWeeklyRoleDigest, buildWeeklyDigestCard, dedupeSubjects, type WeeklyDigest } from "./weekly.js";

describe("dedupeSubjects", () => {
  it("去重保序、去空白", () => {
    expect(dedupeSubjects(["导入去重弹窗", " 卡片标点全角 ", "导入去重弹窗", "", "抽出锚定菜单"])).toEqual([
      "导入去重弹窗",
      "卡片标点全角",
      "抽出锚定菜单",
    ]);
  });
});

describe("buildWeeklyDigestCard", () => {
  const base: WeeklyDigest = {
    weekLabel: "2026-06-08 ~ 06-14（北京时间）",
    weekStart: new Date("2026-06-07T16:00:00Z"),
    generatedAt: new Date("2026-06-12T13:00:00Z"),
    roles: [],
    totals: { created: 0, updated: 0 },
  };
  const cardText = (card: unknown) =>
    (card as { elements: Array<{ text?: { content: string } }> }).elements.map((e) => e.text?.content ?? "").join("\n");

  it("含知识库 + 研发(仓库 + 简评)两段", () => {
    const card = buildWeeklyDigestCard(
      { ...base, roles: [{ roleId: "r1", roleName: "产品", created: ["A"], updated: ["B"] }], totals: { created: 1, updated: 1 } },
      { repos: [{ label: "me/app", count: 3, subjects: ["加登录", "修崩溃"] }], review: "本周上线登录并修复一处崩溃。" },
    );
    const text = cardText(card);
    expect((card as { header: { title: { content: string } } }).header.title.content).toContain("本周周报");
    expect((card as { header: { title: { content: string } } }).header.title.content).not.toContain("北京时间");
    expect(text).toContain("知识库内容更新");
    expect(text).toContain("产品");
    expect(text).toContain("研发改动");
    expect(text).toContain("me/app");
    expect(text).toContain("本周 3 个提交");
    expect(text).toContain("加登录");
    expect(text).toContain("本周小结");
  });

  it("仓库拉取失败 → 单独标注,不影响整体", () => {
    const card = buildWeeklyDigestCard(base, { repos: [{ label: "me/priv", count: 0, subjects: [], error: "token 无效或权限不足(401)" }] });
    const text = cardText(card);
    expect(text).toContain("me/priv");
    expect(text).toContain("拉取失败");
  });

  it("无任何更新 → 一张「暂无」卡片", () => {
    const text = cardText(buildWeeklyDigestCard(base, { repos: [] }));
    expect(text).toContain("暂无可量化");
  });

  it("有知识库无研发 → 不出研发段", () => {
    const card = buildWeeklyDigestCard(
      { ...base, roles: [{ roleId: "r1", roleName: "产品", created: ["A"], updated: [] }], totals: { created: 1, updated: 0 } },
      { repos: [] },
    );
    expect(cardText(card)).not.toContain("研发改动");
  });
});

describe("computeWeeklyRoleDigest", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("按角色统计本周 新增/更新(旧文档)", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    // 旧文档:创建于本周之前,本周有一次编辑版本(→ 命中"更新")。
    const old = await prisma.article.create({
      data: { title: "旧文档", contentMarkdown: "x", roleId: role.id, createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.articleVersion.create({ data: { articleId: old.id, title: "旧文档", contentMarkdown: "x", kind: "edit" } });
    // 本周新建文档(createdAt 默认 = 现在)。
    await prisma.article.create({ data: { title: "新文档", contentMarkdown: "y", roleId: role.id } });

    const now = new Date(Date.now() + 1000); // 确保窗口上界覆盖以上写入时刻
    const d = await computeWeeklyRoleDigest(now);

    expect(d.totals).toEqual({ created: 1, updated: 1 });
    expect(d.roles).toHaveLength(1);
    const r = d.roles[0]!;
    expect(r.roleName).toBe("产品");
    expect(r.created).toEqual(["新文档"]);
    expect(r.updated).toEqual(["旧文档"]);
  });

  it("只改排序（updatedAt 变了但没有内容版本）不算更新；导入 / 回滚 / 一键优化版本算", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const mk = (title: string) => prisma.article.create({
      data: { title, contentMarkdown: "x", roleId: role.id, createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const sorted = await mk("只调排序");
    await prisma.article.update({ where: { id: sorted.id }, data: { sortOrder: 3 } });
    for (const kind of ["import", "restore", "ai-fix"]) {
      const a = await mk(`版本-${kind}`);
      await prisma.articleVersion.create({ data: { articleId: a.id, title: a.title, contentMarkdown: "x", kind } });
    }
    const d = await computeWeeklyRoleDigest(new Date(Date.now() + 1000));
    expect(d.totals.updated).toBe(3);
    expect(d.roles[0]!.updated).not.toContain("只调排序");
  });

  it("本周无变动 → roles 为空、totals 全 0", async () => {
    await prisma.role.create({ data: { name: "空" } });
    const d = await computeWeeklyRoleDigest(new Date());
    expect(d.roles).toHaveLength(0);
    expect(d.totals).toEqual({ created: 0, updated: 0 });
  });
});
