import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { contentHash, reviewArticle } from "./review.js";
import { addDismissed } from "./dismiss.js";
import { invalidateAssistantExclusionCache } from "../assistant-filter/exclusions.js";
import { reviewFindingHash } from "./findings.js";

const ISSUE_JSON = JSON.stringify({ findings: [{ category: "logic", severity: "high", problem: "前后矛盾", suggestion: "统一" }] });

describe("reviewArticle", () => {
  beforeEach(async () => { await resetDb(); invalidateAssistantExclusionCache(); });
  afterAll(async () => { await disconnectDb(); });

  async function seedArt() {
    const u = await seedUser({ ssoId: "ou_a" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    return prisma.article.create({ data: { title: "T", contentMarkdown: "这是一段足够长的正文用于校验。", roleId: role.id, createdById: u.id } });
  }

  it("有问题 → issues + 写 reviewFindings/hash,且不 bump updatedAt", async () => {
    const art = await seedArt();
    const before = (await prisma.article.findUnique({ where: { id: art.id } }))!.updatedAt;
    const out = await reviewArticle(art.id, { notify: false, runLlm: async () => ISSUE_JSON });
    expect(out?.status).toBe("issues");
    const row = (await prisma.article.findUnique({ where: { id: art.id } }))!;
    expect(row.reviewStatus).toBe("issues");
    expect(JSON.parse(row.reviewFindings!)).toHaveLength(1);
    expect(row.reviewedHash).toBe(contentHash(art.title, art.contentMarkdown));
    expect(row.updatedAt.getTime()).toBe(before.getTime()); // 未 bump
  });

  it("无问题 → ok,reviewFindings 清空", async () => {
    const art = await seedArt();
    const out = await reviewArticle(art.id, { notify: false, runLlm: async () => '{"findings":[]}' });
    expect(out?.status).toBe("ok");
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.reviewFindings).toBeNull();
  });

  it("已忽略的问题被过滤 → 视为无问题", async () => {
    const art = await seedArt();
    await addDismissed(art.id, [{ category: "logic", severity: "high", problem: "前后矛盾", suggestion: "", hash: reviewFindingHash({ category: "logic", problem: "前后矛盾" }) }], "u");
    const out = await reviewArticle(art.id, { notify: false, runLlm: async () => ISSUE_JSON });
    expect(out?.status).toBe("ok");
  });

  it("(A)严重度阈值:默认过滤 low 级问题 → 视为无问题(ok)", async () => {
    const art = await seedArt();
    const lowJson = JSON.stringify({ findings: [{ category: "clarity", severity: "low", problem: "措辞可更顺", suggestion: "润色" }] });
    const out = await reviewArticle(art.id, { notify: false, runLlm: async () => lowJson });
    expect(out?.status).toBe("ok");
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.reviewStatus).toBe("ok");
  });

  it("(D)两遍取交集:只在一遍出现的问题被丢弃,只保留两遍都报的", async () => {
    const art = await seedArt();
    const both = { category: "logic", severity: "high", problem: "前后矛盾", suggestion: "统一" };
    const onlyFirst = { category: "clarity", severity: "high", problem: "指代不明", suggestion: "明确" };
    let call = 0;
    const out = await reviewArticle(art.id, {
      notify: false,
      runLlm: async () => {
        call++;
        return JSON.stringify({ findings: call === 1 ? [both, onlyFirst] : [both] });
      },
    });
    expect(out?.status).toBe("issues");
    const persisted = JSON.parse((await prisma.article.findUnique({ where: { id: art.id } }))!.reviewFindings!);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].problem).toBe("前后矛盾");
  });

  it("(格式预检)标题残留 ** → 即便 LLM 无问题也报 format(issues)", async () => {
    const u = await seedUser({ ssoId: "ou_f" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const art = await prisma.article.create({
      data: { title: "T", contentMarkdown: "# 概述\n\n## **聊天场景内容卡**\n\n这是一段足够长的正文用于校验内容。", roleId: role.id, createdById: u.id },
    });
    const out = await reviewArticle(art.id, { notify: false, runLlm: async () => '{"findings":[]}' });
    expect(out?.status).toBe("issues");
    expect(out?.findings.some((f) => f.category === "format")).toBe(true);
  });

  it("LLM 失败(返回 null)→ 不改状态,返回 null", async () => {
    const art = await seedArt();
    const out = await reviewArticle(art.id, { notify: false, runLlm: async () => null });
    expect(out).toBeNull();
    expect((await prisma.article.findUnique({ where: { id: art.id } }))!.reviewStatus).toBe("none");
  });

  it("TOCTOU:校验期间内容被改动 → 不落库、返回 null(条件写未命中)", async () => {
    const art = await seedArt();
    // 注入的 runLlm 在「返回前」模拟并发保存:bump updatedAt(用真实 update 改内容)。
    const out = await reviewArticle(art.id, {
      notify: false,
      runLlm: async () => {
        // 模拟并发保存:显式把 updatedAt 设为明显更晚的值(避免与取内容时同一毫秒导致条件写仍命中)。
        await prisma.$executeRaw`UPDATE "Article" SET "contentMarkdown" = '用户在校验期间改了正文……', "updatedAt" = ${Date.now() + 60_000} WHERE "id" = ${art.id}`;
        return ISSUE_JSON;
      },
    });
    expect(out).toBeNull();
    const row = (await prisma.article.findUnique({ where: { id: art.id } }))!;
    expect(row.reviewStatus).toBe("none");   // 旧状态保留,未被写成 issues
    expect(row.reviewFindings).toBeNull();
  });
});
