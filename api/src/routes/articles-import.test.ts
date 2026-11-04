import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

const BOUNDARY = "----ImportTestBoundary";

function buildMultipart(fields: Record<string, string>, filename: string, content: string): Buffer {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`,
    ),
  );
  chunks.push(Buffer.from(content));
  chunks.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

async function importMd(
  app: Awaited<ReturnType<typeof buildServer>>,
  cookie: string,
  opts: { roleId: string; folderId?: string | null; title: string; content?: string; onConflict?: string },
) {
  const fields: Record<string, string> = { roleId: opts.roleId, title: opts.title, folderId: opts.folderId ?? "null" };
  if (opts.onConflict) fields.onConflict = opts.onConflict;
  return app.inject({
    method: "POST",
    url: "/api/articles/import",
    headers: { cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: buildMultipart(fields, "doc.md", opts.content ?? "# hello\n正文 A\n"),
  });
}

describe("POST /api/articles/import — 同名冲突处理", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function setup() {
    await seedAdmin();
    const role = await prisma.role.create({ data: { name: "测试角色" } });
    const app = await buildServer(AUTH);
    return { app, cookie: authCookie("admin"), roleId: role.id };
  }

  it("无同名时正常创建文档", async () => {
    const { app, cookie, roleId } = await setup();
    const res = await importMd(app, cookie, { roleId, title: "文档", content: "# A\n" });
    expect(res.statusCode).toBe(201);
    const { article } = res.json();
    expect(article.title).toBe("文档");
    // 去状态后导入不再记 publish 版本 —— 新建即为可见文档,无版本历史。
    const versions = await prisma.articleVersion.findMany({ where: { articleId: article.id } });
    expect(versions).toHaveLength(0);
    await app.close();
  });

  it("同一容器内重名且未指定 onConflict → 409 duplicate_title + existing", async () => {
    const { app, cookie, roleId } = await setup();
    const first = await importMd(app, cookie, { roleId, title: "文档", content: "# A\n" });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().article.id;

    const dup = await importMd(app, cookie, { roleId, title: "文档", content: "# B\n" });
    expect(dup.statusCode).toBe(409);
    const body = dup.json();
    expect(body.error).toBe("duplicate_title");
    expect(body.existing.id).toBe(firstId);
    expect(body.existing.title).toBe("文档");

    // 409 不应创建任何新文档
    const count = await prisma.article.count({ where: { roleId, title: "文档", deletedAt: null } });
    expect(count).toBe(1);
    await app.close();
  });

  it("overwrite → 原内容存历史版本(kind=import)、正文替换", async () => {
    const { app, cookie, roleId } = await setup();
    const first = await importMd(app, cookie, { roleId, title: "文档", content: "# 原始内容\n" });
    const id = first.json().article.id;

    const res = await importMd(app, cookie, { roleId, title: "文档", content: "# 新内容\n", onConflict: "overwrite" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overwritten).toBe(true);
    expect(body.article.id).toBe(id); // 覆盖的是同一篇

    const after = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(after.contentMarkdown).toBe("# 新内容\n");

    const versions = await prisma.articleVersion.findMany({ where: { articleId: id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.kind).toBe("import");
    expect(versions[0]!.contentMarkdown).toBe("# 原始内容\n"); // 导入前内容入历史

    // 没有新增第二篇文档
    expect(await prisma.article.count({ where: { roleId, deletedAt: null } })).toBe(1);
    await app.close();
  });

  it("rename → 新文档自动取「标题 (2)」,原文档不变", async () => {
    const { app, cookie, roleId } = await setup();
    const first = await importMd(app, cookie, { roleId, title: "文档", content: "# 原始\n" });
    const firstId = first.json().article.id;

    const res = await importMd(app, cookie, { roleId, title: "文档", content: "# 第二份\n", onConflict: "rename" });
    expect(res.statusCode).toBe(201);
    const { article } = res.json();
    expect(article.title).toBe("文档 (2)");
    expect(article.id).not.toBe(firstId);

    const original = await prisma.article.findUniqueOrThrow({ where: { id: firstId } });
    expect(original.contentMarkdown).toBe("# 原始\n"); // 原文档未被动
    await app.close();
  });

  it("rename 连续多次 → 递增到 (3)", async () => {
    const { app, cookie, roleId } = await setup();
    await importMd(app, cookie, { roleId, title: "文档" });
    const r2 = await importMd(app, cookie, { roleId, title: "文档", onConflict: "rename" });
    expect(r2.json().article.title).toBe("文档 (2)");
    const r3 = await importMd(app, cookie, { roleId, title: "文档", onConflict: "rename" });
    expect(r3.json().article.title).toBe("文档 (3)");
    await app.close();
  });

  it("不同容器(目录)同名不算冲突 → 正常创建", async () => {
    const { app, cookie, roleId } = await setup();
    await importMd(app, cookie, { roleId, title: "文档", content: "# 角色直属\n" }); // role-direct
    const folder = await prisma.folder.create({ data: { name: "目录A", roleId } });

    const res = await importMd(app, cookie, { roleId, folderId: folder.id, title: "文档", content: "# 目录内\n" });
    expect(res.statusCode).toBe(201); // 不同容器,无冲突
    expect(res.json().article.title).toBe("文档");
    expect(await prisma.article.count({ where: { roleId, title: "文档", deletedAt: null } })).toBe(2);
    await app.close();
  });

  it("回收站里的同名文档不算冲突", async () => {
    const { app, cookie, roleId } = await setup();
    const first = await importMd(app, cookie, { roleId, title: "文档" });
    await prisma.article.update({ where: { id: first.json().article.id }, data: { deletedAt: new Date() } });

    const res = await importMd(app, cookie, { roleId, title: "文档", content: "# 新的\n" });
    expect(res.statusCode).toBe(201); // 原同名已在回收站 → 不冲突
    await app.close();
  });

  it("字段排在 file 之后:rename/onConflict 仍被正确读取(req.parts 修法)", async () => {
    // buildMultipart 把 fields 放在 file 之后来复现旧版本的丢失问题。
    const { app, cookie, roleId } = await setup();
    // 先导入同名文档制造冲突
    await importMd(app, cookie, { roleId, title: "字段顺序测试" });

    // 手工构造 file 在前、onConflict 在后的 multipart body
    const BOUND = "----FieldsAfterFileBoundary";
    const buildFieldsAfterFile = (roleId: string, title: string, onConflict: string, content: string): Buffer => {
      const chunks: Buffer[] = [];
      // file part 先
      chunks.push(Buffer.from(`--${BOUND}\r\nContent-Disposition: form-data; name="file"; filename="doc.md"\r\nContent-Type: text/markdown\r\n\r\n`));
      chunks.push(Buffer.from(content));
      chunks.push(Buffer.from(`\r\n`));
      // fields 后(旧版本 req.file() 读不到)
      for (const [k, v] of [["roleId", roleId], ["title", title], ["onConflict", onConflict]] as [string, string][]) {
        chunks.push(Buffer.from(`--${BOUND}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      }
      chunks.push(Buffer.from(`--${BOUND}--\r\n`));
      return Buffer.concat(chunks);
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/articles/import",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${BOUND}` },
      payload: buildFieldsAfterFile(roleId, "字段顺序测试", "rename", "# 新内容\n"),
    });
    // 使用 req.parts() 后,字段无论顺序都应被正确读取 → 201 且标题自动改名
    expect(res.statusCode).toBe(201);
    expect(res.json().article.title).toBe("字段顺序测试 (2)");
    await app.close();
  });

  it("rename 精确匹配:「文档说明」不占用「文档」的序号槽", async () => {
    const { app, cookie, roleId } = await setup();
    // 存在「文档」和「文档说明」两篇
    await importMd(app, cookie, { roleId, title: "文档" });
    await importMd(app, cookie, { roleId, title: "文档说明" });

    // rename 冲突「文档」时,占用集只含「文档」和「文档 (n)」,不含「文档说明」
    const res = await importMd(app, cookie, { roleId, title: "文档", onConflict: "rename" });
    expect(res.statusCode).toBe(201);
    expect(res.json().article.title).toBe("文档 (2)"); // 不是「文档 (3)」
    await app.close();
  });

  it("rename 超过 1000 个同名 → 409 too_many_duplicates", async () => {
    const { app, cookie, roleId } = await setup();
    // 直接在 DB 写入 1001 篇同名文档来模拟已满。一次 createMany 写完 —— 逐条 create
    // (每条还先查一次用户)约 2000 次查询，在慢机器上会超过默认 5s 用例超时。
    const createdById = (await prisma.user.findFirstOrThrow()).id;
    await prisma.article.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        title: i === 0 ? "爆表" : `爆表 (${i + 1})`,
        contentMarkdown: "",
        roleId,
        sortOrder: i,
        createdById,
      })),
    });
    const res = await importMd(app, cookie, { roleId, title: "爆表", onConflict: "rename" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("too_many_duplicates");
    await app.close();
  });
});
