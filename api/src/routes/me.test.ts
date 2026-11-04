import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

const SSO_ID = "admin";

describe("GET /api/me", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser({ ssoId: SSO_ID, displayName: "Admin", isAdmin: true });
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("returns { user: null } when not logged in (no sso_session cookie)", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null, assistantName: "AI", appLanguage: "zh" });
    await app.close();
  });

  it("returns English error messages for X-Lang: en and Chinese otherwise", async () => {
    const app = await buildServer(AUTH);
    const cookie = authCookie(SSO_ID);
    const en = await app.inject({
      method: "PATCH", url: "/api/me/profile", headers: { cookie, "x-lang": "en" }, payload: {},
    });
    expect(en.statusCode).toBe(400);
    expect(en.json().message).toBe("No fields to update");
    const zh = await app.inject({
      method: "PATCH", url: "/api/me/profile", headers: { cookie }, payload: {},
    });
    expect(zh.json().message).toBe("无可更新字段");
    const tooLong = await app.inject({
      method: "PATCH", url: "/api/me/profile", headers: { cookie, "x-lang": "en" }, payload: { chatPreference: "x".repeat(201) },
    });
    expect(tooLong.json().message).toBe("Chat preference can be at most 200 characters");
    await app.close();
  });

  it("returns the current user when authenticated via SSO", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: authCookie(SSO_ID) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.displayName).toBe("Admin");
    expect(res.json().user.isAdmin).toBe(true);
    expect(res.json().assistantName).toBe("AI");
    // SSO-backed shape: no username / mustChangePassword; email present.
    expect(res.json().user).not.toHaveProperty("username");
    expect(res.json().user).not.toHaveProperty("mustChangePassword");
    expect(res.json().user).toHaveProperty("email");
    await app.close();
  });

  it("JIT-provisions a local user on first authenticated request", async () => {
    await prisma.user.deleteMany();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: authCookie("brand-new-sso-id") },
    });
    expect(res.statusCode).toBe(200);
    // The whoami mock names the user "User <sid>".
    expect(res.json().user.displayName).toBe("User brand-new-sso-id");
    // Not in any admin allowlist (empty in tests) → non-admin.
    expect(res.json().user.isAdmin).toBe(false);
    const row = await prisma.user.findUnique({ where: { ssoId: "brand-new-sso-id" } });
    expect(row).not.toBeNull();
    await app.close();
  });

  it("returns 403 inactive when the local user is deactivated", async () => {
    await prisma.user.update({ where: { ssoId: SSO_ID }, data: { isActive: false } });
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: authCookie(SSO_ID) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("inactive");
    await app.close();
  });
});

describe("PATCH /api/me/profile", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser({ ssoId: SSO_ID, displayName: "Admin", isAdmin: true });
  });

  // displayName is SSO-sourced (Feishu) and read-only here: profilePatchSchema
  // accepts ONLY chatPreference, so a patch carrying just displayName has no
  // updatable field → 400, and the stored displayName is untouched. (The
  // separate "empty (no-op) patch with 400" test below shares this code path
  // — both prove the only self-editable field is chatPreference.)
  it("rejects a displayName-only patch (displayName is read-only / SSO-sourced) and does not change it", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: { cookie: authCookie(SSO_ID), "content-type": "application/json" },
      payload: { displayName: "新名字" },
    });
    expect(res.statusCode).toBe(400);
    // The seeded displayName must be unchanged in the DB.
    const row = await prisma.user.findUniqueOrThrow({ where: { ssoId: SSO_ID } });
    expect(row.displayName).toBe("Admin");
    await app.close();
  });

  it("updates chatPreference (the only self-editable field) and persists it", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: { cookie: authCookie(SSO_ID), "content-type": "application/json" },
      payload: { chatPreference: "简洁、专业" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.chatPreference).toBe("简洁、专业");
    // displayName is still the SSO value — a chatPreference patch never touches it.
    expect(res.json().user.displayName).toBe("Admin");
    const row = await prisma.user.findUniqueOrThrow({ where: { ssoId: SSO_ID } });
    expect(row.chatPreference).toBe("简洁、专业");
    await app.close();
  });

  it("rejects unauthenticated profile update with 401", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: { "content-type": "application/json" },
      payload: { displayName: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an empty (no-op) patch with 400", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: { cookie: authCookie(SSO_ID), "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// The feed must push canView into the QUERY so a `take`-bounded
// page isn't under-filled by other users' invisible drafts. canView:
// published/archived visible to all; a draft only to its author/collaborator.
describe("GET /api/me/feed visibility (query-level canView)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("feed 包含全部未删除文档(去草稿隐私:他人文档也可见)", async () => {
    const me = await seedUser({ ssoId: "me", displayName: "Me" });
    const other = await seedUser({ ssoId: "other", displayName: "Other" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const a1 = await prisma.article.create({ data: { title: "公开", contentMarkdown: "x", roleId: role.id, createdById: other.id } });
    const a2 = await prisma.article.create({ data: { title: "我的文档", contentMarkdown: "x", roleId: role.id, createdById: me.id } });
    const a3 = await prisma.article.create({ data: { title: "他的文档", contentMarkdown: "x", roleId: role.id, createdById: other.id } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/me/feed", headers: { cookie: authCookie("me") } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().articles as Array<{ id: string }>).map((a) => a.id).sort();
    expect(ids).toEqual([a1.id, a2.id, a3.id].sort());
    await app.close();
  });
});

// Regression: a FOLDER-scoped feed (the folder landing page) must follow the
// manual drag-order (sortOrder) so it matches the sidebar tree. It used to
// order purely by updatedAt desc, ignoring sortOrder — which made the folder
// page, the sidebar, and a post-refresh sidebar all disagree.
describe("GET /api/me/feed?folderId ordering follows sortOrder (matches sidebar)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("orders a folder's docs by sortOrder (drag order), not updatedAt", async () => {
    const me = await seedUser({ ssoId: "me", displayName: "Me" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const folder = await prisma.folder.create({ data: { name: "目录", roleId: role.id } });
    // Created A→B→C (so A is oldest, C is newest-updated), but dragged to the
    // order B(0), C(1), A(2). The feed must honor sortOrder, not creation/update time.
    const a = await prisma.article.create({ data: { title: "A", contentMarkdown: "x", roleId: role.id, folderId: folder.id, createdById: me.id, sortOrder: 2 } });
    const b = await prisma.article.create({ data: { title: "B", contentMarkdown: "x", roleId: role.id, folderId: folder.id, createdById: me.id, sortOrder: 0 } });
    const c = await prisma.article.create({ data: { title: "C", contentMarkdown: "x", roleId: role.id, folderId: folder.id, createdById: me.id, sortOrder: 1 } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/me/feed?folderId=${folder.id}`, headers: { cookie: authCookie("me") } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().articles as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual([b.id, c.id, a.id]); // sortOrder 0,1,2 — NOT update/creation order
    await app.close();
  });

  it("a tie in sortOrder falls back to createdAt asc (stable, not updatedAt)", async () => {
    const me = await seedUser({ ssoId: "me", displayName: "Me" });
    const role = await prisma.role.create({ data: { name: "产品" } });
    const folder = await prisma.folder.create({ data: { name: "目录", roleId: role.id } });
    // Both at sortOrder 0 (legacy/never-reordered) — earlier-created comes first.
    const first = await prisma.article.create({ data: { title: "先", contentMarkdown: "x", roleId: role.id, folderId: folder.id, createdById: me.id, sortOrder: 0 } });
    const second = await prisma.article.create({ data: { title: "后", contentMarkdown: "x", roleId: role.id, folderId: folder.id, createdById: me.id, sortOrder: 0 } });
    // Edit `first` so its updatedAt is newest — it must STILL come first (stable).
    await prisma.article.update({ where: { id: first.id }, data: { title: "先(已编辑)" } });

    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: `/api/me/feed?folderId=${folder.id}`, headers: { cookie: authCookie("me") } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().articles as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual([first.id, second.id]); // createdAt asc — edit must not reshuffle
    await app.close();
  });
});
