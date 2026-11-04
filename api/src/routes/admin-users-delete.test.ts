// 删除用户会级联删除其上传记录与会议;有内容的用户必须先停用而不是删除。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

async function upload(app: Awaited<ReturnType<typeof buildServer>>, cookie: string): Promise<string> {
  const boundary = "----PB";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG_BYTES,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: "POST", url: "/api/uploads/image",
    headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().url as string;
}

describe("DELETE /api/admin/users/:id 保护有内容的用户", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("有上传记录 -> 409 user_has_content,他人文档里的图片仍可读", async () => {
    await seedAdmin();
    const u = await seedUser({ ssoId: "u" });
    const o = await seedUser({ ssoId: "o" });
    const role = await prisma.role.create({ data: { name: `r-${Date.now()}` } });
    await prisma.userRole.createMany({ data: [{ userId: u.id, roleId: role.id }, { userId: o.id, roleId: role.id }] });
    const folder = await prisma.folder.create({ data: { name: "m", roleId: role.id, visibility: "public", templateType: "article-list" } });
    const app = await buildServer(AUTH);
    const url = await upload(app, authCookie("u"));
    await prisma.article.create({
      data: { title: "doc", contentMarkdown: `![x](${url})`, folderId: folder.id, roleId: role.id, createdById: o.id },
    });

    const del = await app.inject({ method: "DELETE", url: `/api/admin/users/${u.id}`, headers: { cookie: authCookie("admin") } });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe("user_has_content");
    expect(del.json().uploads).toBe(1);
    expect(del.json().meetings).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: u.id } })).not.toBeNull();

    const img = await app.inject({ method: "GET", url, headers: { cookie: authCookie("o") } });
    expect(img.statusCode).toBe(200);
    await app.close();
  });

  it("创建过会议 -> 409 并带会议计数", async () => {
    await seedAdmin();
    const u = await seedUser({ ssoId: "u" });
    await prisma.meetingSession.create({ data: { title: "周会", createdById: u.id, allowedRoleIds: "[]", config: "{}" } });
    const app = await buildServer(AUTH);
    const del = await app.inject({ method: "DELETE", url: `/api/admin/users/${u.id}`, headers: { cookie: authCookie("admin") } });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ error: "user_has_content", meetings: 1, uploads: 0 });
    await app.close();
  });

  it("无内容的用户仍可删除 -> 204", async () => {
    await seedAdmin();
    const u = await seedUser({ ssoId: "u" });
    const app = await buildServer(AUTH);
    const del = await app.inject({ method: "DELETE", url: `/api/admin/users/${u.id}`, headers: { cookie: authCookie("admin") } });
    expect(del.statusCode).toBe(204);
    await app.close();
  });
});
