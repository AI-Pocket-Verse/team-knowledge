// 写正文的入口(新建 / 导入 / 覆盖导入 / 飞书导入)都要建反向引用并标记角色技能待更新。
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/role-skill/dispatcher.js", () => ({
  kickRoleSkill: vi.fn(async () => {}),
  startRoleSkillDispatcher: vi.fn(),
  QUIET_MS: 300_000,
  MAX_ATTEMPTS: 3,
  MAX_PER_SWEEP: 2,
}));
vi.mock("../utils/feishuGateway.js", () => ({
  FeishuGatewayError: class FeishuGatewayError extends Error {
    constructor(public code: string, public status: number) { super(code); }
  },
  feishuGateway: {
    getDocxMeta: vi.fn(async () => ({ title: "飞书文档" })),
    listDocxBlocks: vi.fn(async () => ({
      blocks: [
        { block_id: "p", block_type: 1, page: {}, children: ["t"] },
        { block_id: "t", block_type: 2, text: { elements: [{ text_run: { content: "参见 /d/TARGETID1 这篇", text_element_style: {} } }] } },
      ],
    })),
    resolveWikiNode: vi.fn(),
    downloadMedia: vi.fn(),
    downloadWhiteboardImage: vi.fn(),
    listBitableFields: vi.fn(),
    listBitableRecords: vi.fn(),
    readSheetRange: vi.fn(),
    getWhiteboardNodes: vi.fn(async () => ({ nodes: [] })),
  },
}));

import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { flushBestEffortWrites } from "../utils/guards.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
const BOUNDARY = "----LinksBoundary";

function multipart(fields: Record<string, string>, content: string): Buffer {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="d.md"\r\nContent-Type: text/markdown\r\n\r\n`));
  chunks.push(Buffer.from(content), Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

describe("写正文入口的引用与技能待更新", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function setup() {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "KB" } });
    const target = await prisma.article.create({
      data: { id: "TARGETID1", title: "目标", contentMarkdown: "x", roleId: role.id, createdById: admin.id },
    });
    // 清掉建目标文档之外可能已存在的技能行,断言只看被测入口造成的变化
    await prisma.roleSkill.deleteMany();
    const app = await buildServer(AUTH);
    return { app, cookie: authCookie("admin"), role, target };
  }

  async function expectLinked(articleId: string, targetId: string, roleId: string) {
    await flushBestEffortWrites();
    expect(await prisma.articleReference.count({ where: { fromArticleId: articleId, toArticleId: targetId } })).toBe(1);
    expect((await prisma.roleSkill.findUnique({ where: { roleId } }))?.status).toBe("stale");
  }

  it("POST /api/articles 新建", async () => {
    const { app, cookie, role, target } = await setup();
    const res = await app.inject({
      method: "POST", url: "/api/articles", headers: { cookie },
      payload: { roleId: role.id, title: "新", contentMarkdown: `见 [目标](/d/${target.id})` },
    });
    expect(res.statusCode).toBe(201);
    await expectLinked(res.json().article.id, target.id, role.id);
    await app.close();
  });

  it("POST /api/articles/import 新建", async () => {
    const { app, cookie, role, target } = await setup();
    const res = await app.inject({
      method: "POST", url: "/api/articles/import",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ roleId: role.id, title: "导入", folderId: "null" }, `见 [目标](/d/${target.id})`),
    });
    expect(res.statusCode).toBe(201);
    await expectLinked(res.json().article.id, target.id, role.id);
    const inbound = await prisma.articleReference.findMany({ where: { toArticleId: target.id } });
    expect(inbound).toHaveLength(1);
    await app.close();
  });

  it("POST /api/articles/import 覆盖:换掉旧引用并标记待更新", async () => {
    const { app, cookie, role, target } = await setup();
    const other = await prisma.article.create({ data: { title: "别的", contentMarkdown: "y", roleId: role.id, createdById: target.createdById } });
    const dup = await prisma.article.create({
      data: { title: "同名", contentMarkdown: `旧 /d/${other.id}`, roleId: role.id, createdById: target.createdById },
    });
    await prisma.articleReference.create({ data: { fromArticleId: dup.id, toArticleId: other.id } });
    await prisma.roleSkill.deleteMany();
    const res = await app.inject({
      method: "POST", url: "/api/articles/import",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ roleId: role.id, title: "同名", folderId: "null", onConflict: "overwrite" }, `新 /d/${target.id}`),
    });
    expect(res.statusCode).toBe(200);
    await expectLinked(dup.id, target.id, role.id);
    expect(await prisma.articleReference.count({ where: { fromArticleId: dup.id, toArticleId: other.id } })).toBe(0);
    await app.close();
  });

  it("POST /api/articles/import-feishu", async () => {
    const { app, cookie, role, target } = await setup();
    const res = await app.inject({
      method: "POST", url: "/api/articles/import-feishu", headers: { cookie },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/docx/Doc1", unsupportedMode: "placeholder" },
    });
    expect(res.statusCode).toBe(201);
    await expectLinked(res.json().article.id, target.id, role.id);
    await app.close();
  });
});
