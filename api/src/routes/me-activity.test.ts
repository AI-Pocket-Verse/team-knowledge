import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("GET /api/me/activity", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("requires auth (401 without a session cookie)", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/me/activity" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns ONLY the caller's own activity, paginated 10/page", async () => {
    const me = await seedUser({ ssoId: "me", displayName: "Me" });
    const other = await seedUser({ ssoId: "other", displayName: "Other" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    for (let i = 0; i < 11; i++) {
      await prisma.article.create({ data: { title: `d${i}`, contentMarkdown: "x", roleId: role.id, createdById: me.id } });
    }
    // Another user's op must NOT leak into my feed.
    await prisma.article.create({ data: { title: "其他", contentMarkdown: "x", roleId: role.id, createdById: other.id } });

    const app = await buildServer(AUTH);
    const get = (q: string) => app.inject({ method: "GET", url: `/api/me/activity${q}`, headers: { cookie: authCookie("me") } });

    const p1 = (await get("")).json();
    expect(p1.total).toBe(11);
    expect(p1.items).toHaveLength(10);
    expect(p1.hasMore).toBe(true);
    expect(p1.items.every((it: { userId: string }) => it.userId === me.id)).toBe(true);

    const p2 = (await get("?page=2")).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
    await app.close();
  });
});
