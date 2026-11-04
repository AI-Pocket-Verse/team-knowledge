import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock the auth gateway HTTP client — no live Feishu in unit tests. The blocks
// returned here mirror the real Feishu docx block shape so normalize+convert
// run end-to-end against the route.
vi.mock("../utils/feishuGateway.js", () => ({
  FeishuGatewayError: class FeishuGatewayError extends Error {
    constructor(
      public code: string,
      public status: number,
    ) {
      super(code);
    }
  },
  feishuGateway: {
    getDocxMeta: vi.fn(async () => ({ title: "飞书原标题" })),
    listDocxBlocks: vi.fn(async () => ({
      blocks: [
        { block_id: "p", block_type: 1, page: {}, children: ["t", "b", "m"] },
        { block_id: "t", block_type: 2, text: { elements: [{ text_run: { content: "正文", text_element_style: {} } }] } },
        { block_id: "b", block_type: 18, bitable: { token: "appX_tblY" } }, // resolvable → GFM table
        { block_id: "m", block_type: 29, mindnote: { token: "mn1" } }, // NOT resolvable → placeholder/drop
      ],
    })),
    resolveWikiNode: vi.fn(async () => ({ objType: "docx", objToken: "doc-from-wiki" })),
    downloadMedia: vi.fn(async () => ({ bytes: Buffer.from("x"), mime: "image/png" })),
    // Valid PNG magic bytes so storeImageBuffer's file-type check passes.
    downloadWhiteboardImage: vi.fn(async () => ({
      bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
      mime: "image/png",
    })),
    listBitableFields: vi.fn(async () => ({ fields: ["名称", "数量"] })),
    listBitableRecords: vi.fn(async () => ({ records: [{ 名称: "苹果", 数量: 3 }] })),
    readSheetRange: vi.fn(async () => ({ values: [["A", "B"], [1, 2]] })),
    getWhiteboardNodes: vi.fn(async () => ({ nodes: [] })), // default: no mermaid → image
  },
}));

import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";
import { feishuGateway } from "../utils/feishuGateway.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("POST /api/articles/import-feishu", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("imports a docx link into a new draft under the role", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/docx/Doc1", unsupportedMode: "placeholder" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { article: { id: string; title: string }; report: { converted: number; placeholderBlocks: number } };
    expect(body.article.title).toBe("飞书原标题");
    expect(body.report.converted).toBeGreaterThan(0);
    // bitable resolved → GFM table; mindnote (not resolvable) → 1 placeholder.
    expect(body.report.placeholderBlocks).toBe(1);
    const saved = await prisma.article.findUnique({ where: { id: body.article.id } });
    expect(saved?.contentMarkdown).toContain("正文");
    expect(saved?.contentMarkdown).toContain("| 名称 | 数量 |"); // bitable → table
    expect(saved?.contentMarkdown).toContain("| 苹果 | 3 |");
    expect(saved?.contentMarkdown).toContain("思维笔记"); // mindnote placeholder
    await app.close();
  });

  it("drop mode drops the UNRESOLVABLE block but still renders a resolvable embed", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/docx/Doc1", unsupportedMode: "drop" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { article: { id: string }; report: { droppedBlocks: number } };
    expect(body.report.droppedBlocks).toBe(1); // mindnote dropped
    const saved = await prisma.article.findUnique({ where: { id: body.article.id } });
    expect(saved?.contentMarkdown).toContain("| 名称 | 数量 |"); // bitable still rendered as table
    expect(saved?.contentMarkdown).not.toContain("思维笔记"); // mindnote omitted
    await app.close();
  });

  it("resolves a wiki link to its docx then imports", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/wiki/Wik1", unsupportedMode: "placeholder" },
    });
    expect(r.statusCode).toBe(201);
    await app.close();
  });

  it("resolves a whiteboard embed (block_type 43) into a rehosted image", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    vi.mocked(feishuGateway.listDocxBlocks).mockResolvedValueOnce({
      blocks: [
        { block_id: "p", block_type: 1, page: {}, children: ["wb"] },
        { block_id: "wb", block_type: 43, board: { token: "wbcn1" } },
      ],
    });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/docx/Doc1", unsupportedMode: "placeholder" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { article: { id: string } };
    const saved = await prisma.article.findUnique({ where: { id: body.article.id } });
    expect(saved?.contentMarkdown).toMatch(/!\[白板\]\(\/uploads\//);
    await app.close();
  });

  it("prefers a mermaid code block when the whiteboard carries diagram syntax", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    vi.mocked(feishuGateway.listDocxBlocks).mockResolvedValueOnce({
      blocks: [
        { block_id: "p", block_type: 1, page: {}, children: ["wb"] },
        { block_id: "wb", block_type: 43, board: { token: "wbcn2" } },
      ],
    });
    vi.mocked(feishuGateway.getWhiteboardNodes).mockResolvedValueOnce({
      nodes: [{ diagram_syntax: "flowchart TD\n  A-->B" }],
    });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/docx/Doc1", unsupportedMode: "placeholder" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { article: { id: string } };
    const saved = await prisma.article.findUnique({ where: { id: body.article.id } });
    expect(saved?.contentMarkdown).toContain("```mermaid");
    expect(saved?.contentMarkdown).toContain("flowchart TD");
    expect(saved?.contentMarkdown).not.toMatch(/!\[白板\]/); // image NOT used
    await app.close();
  });

  it("caps the number of embeds resolved per import (excess → placeholder)", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const children: string[] = [];
    const blocks: Array<Record<string, unknown>> = [{ block_id: "p", block_type: 1, page: {}, children }];
    for (let i = 0; i < 60; i++) {
      const id = "b" + i;
      children.push(id);
      blocks.push({ block_id: id, block_type: 18, bitable: { token: `app_tbl${i}` } });
    }
    vi.mocked(feishuGateway.listDocxBlocks).mockResolvedValueOnce({ blocks });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/docx/Doc1", unsupportedMode: "placeholder" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { report: { placeholderBlocks: number } };
    expect(body.report.placeholderBlocks).toBe(10); // 60 embeds, cap 50 → 10 placeholdered
    await app.close();
  });

  it("rejects an unsupported link with 400", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "产品" } });
    const app = await buildServer(AUTH);
    const r = await app.inject({
      method: "POST",
      url: "/api/articles/import-feishu",
      headers: { cookie: authCookie("admin") },
      payload: { roleId: role.id, folderId: null, url: "https://x.feishu.cn/sheets/S1", unsupportedMode: "placeholder" },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
});
