// 专家头像:上传后设为 RoleExpert.avatarUrl,必须(1)不被孤儿清理删除,(2)对任意登录成员可读。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { env } from "../env.js";
import { cleanupOrphanUploads } from "../utils/uploadCleanup.js";
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

describe("专家头像上传", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function setup() {
    await seedAdmin();
    const alice = await seedUser({ ssoId: "alice" });
    await seedUser({ ssoId: "bob" });
    const role = await prisma.role.create({ data: { name: `r-${Date.now()}` } });
    await prisma.userRole.create({ data: { userId: alice.id, roleId: role.id } });
    const app = await buildServer(AUTH);
    const url = await upload(app, authCookie("alice"));
    const patch = await app.inject({
      method: "PATCH", url: `/api/admin/roles/${role.id}/expert`,
      headers: { cookie: authCookie("alice") }, payload: { avatarUrl: url },
    });
    expect(patch.statusCode).toBe(200);
    return { app, url, filename: url.split("/").pop()! };
  }

  it("孤儿清理不删被专家头像引用的文件", async () => {
    const { app, filename } = await setup();
    await cleanupOrphanUploads({ olderThanMs: 0 });
    expect(await prisma.upload.findUnique({ where: { filename } })).not.toBeNull();
    expect(existsSync(resolve(env.DATA_DIR, "uploads", filename))).toBe(true);
    await app.close();
  });

  it("非上传者的普通成员可读专家头像", async () => {
    const { app, url } = await setup();
    const res = await app.inject({ method: "GET", url, headers: { cookie: authCookie("bob") } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("未被头像引用的未绑定上传仍只有上传者可读", async () => {
    const { app } = await setup();
    const other = await upload(app, authCookie("alice"));
    const res = await app.inject({ method: "GET", url: other, headers: { cookie: authCookie("bob") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
