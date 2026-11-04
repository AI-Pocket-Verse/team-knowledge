// 路由边界输入:重复 query 参数 / 非字符串 ids / 导出头 / front-matter 转义 / 重名取号边界 / 目录计数。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
const BOUNDARY = "----LowBoundary";

describe("路由边界输入", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("/api/me/feed 重复的 folderId / roleId -> 400 invalid_input", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    for (const q of ["folderId=a&folderId=b", "roleId=a&roleId=b"]) {
      const res = await app.inject({ method: "GET", url: `/api/me/feed?${q}`, headers: { cookie } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_input");
    }
    await app.close();
  });

  it("/api/notifications/read ids 含非字符串 -> 400", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/notifications/read",
      headers: { cookie: authCookie("admin") }, payload: { ids: [{}] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    await app.close();
  });

  it("导出:Content-Disposition 带 filename*=UTF-8'' ,front-matter 值含冒号 / # 时仍是合法 YAML 标量", async () => {
    const admin = await seedAdmin({ displayName: "张三: 研发 #1" });
    const role = await prisma.role.create({ data: { name: "产品: 规划" } });
    const folder = await prisma.folder.create({ data: { name: "目录 #2", roleId: role.id, templateType: "article-list" } });
    const a = await prisma.article.create({
      data: { title: "需求文档", contentMarkdown: "body", folderId: folder.id, roleId: role.id, createdById: admin.id },
    });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/articles/${a.id}/export`, headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("需求文档.md")}`);
    expect(res.body).toContain(`author: "张三: 研发 #1"`);
    expect(res.body).toContain(`role: "产品: 规划"`);
    expect(res.body).toContain(`folder: "目录 #2"`);
    await app.close();
  });

  it("导入改名:2..999 号都被占用时取 (1000),不误报 409", async () => {
    const admin = await seedAdmin();
    const role = await prisma.role.create({ data: { name: "R" } });
    await prisma.article.createMany({
      data: Array.from({ length: 999 }, (_, i) => ({
        title: i === 0 ? "占满" : `占满 (${i + 1})`, // 占满、占满 (2) ... 占满 (999)
        contentMarkdown: "", roleId: role.id, sortOrder: i, createdById: admin.id,
      })),
    });
    const app = await buildServer(AUTH);
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roleId"\r\n\r\n${role.id}\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="title"\r\n\r\n占满\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\nnull\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="onConflict"\r\n\r\nrename\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="d.md"\r\nContent-Type: text/markdown\r\n\r\n# x\r\n--${BOUNDARY}--\r\n`,
    );
    const res = await app.inject({
      method: "POST", url: "/api/articles/import",
      headers: { cookie: authCookie("admin"), "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().article.title).toBe("占满 (1000)");
    await app.close();
  });

  it("/api/workspace/roles folderCount 只数未删除目录", async () => {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "R" } });
    await prisma.folder.create({ data: { name: "a", roleId: role.id, templateType: "article-list" } });
    await prisma.folder.create({ data: { name: "b", roleId: role.id, templateType: "article-list", deletedAt: new Date() } });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/workspace/roles", headers: { cookie: authCookie("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles.find((r: { id: string }) => r.id === role.id).folderCount).toBe(1);
    await app.close();
  });
});
