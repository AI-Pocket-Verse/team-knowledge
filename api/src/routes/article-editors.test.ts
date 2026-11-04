import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

// Helper: seed a non-admin user keyed by ssoId so we can act as them
// via authCookie(ssoId).
async function seedNonAdmin(ssoId: string, displayName: string) {
  return prisma.user.create({
    data: {
      ssoId,
      displayName,
      isAdmin: false,
    },
  });
}

async function seedRoleAndFolder(visibility: "public" | "private" = "public") {
  const role = await prisma.role.create({ data: { name: "产品" } });
  const mod = await prisma.folder.create({ data: { name: "M", roleId: role.id, visibility } });
  return { role, mod };
}

describe("article-editors routes", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  describe("email 不外泄", () => {
    it("POST 与 GET 响应都不含 email", async () => {
      const author = await seedNonAdmin("author", "Author");
      const guest = await prisma.user.create({ data: { ssoId: "guest", displayName: "Guest", email: "guest@example.com" } });
      const { role, mod } = await seedRoleAndFolder();
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: role.id, createdById: author.id } });
      const app = await buildServer(AUTH);
      const cookie = authCookie("author");

      const post = await app.inject({ method: "POST", url: `/api/articles/${a.id}/editors`, headers: { cookie }, payload: { userId: guest.id } });
      expect(post.statusCode).toBe(201);
      expect(post.json().editor).not.toHaveProperty("email");
      expect(post.body).not.toContain("guest@example.com");

      const list = await app.inject({ method: "GET", url: `/api/articles/${a.id}/editors`, headers: { cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().editors).toHaveLength(1);
      expect(list.json().editors[0]).not.toHaveProperty("email");
      expect(list.body).not.toContain("guest@example.com");
      await app.close();
    });
  });

  describe("POST /api/articles/:id/editors", () => {
    it("author can grant editor, target can then edit a published article in a private folder", async () => {
      const author = await seedNonAdmin("author", "Author");
      const guest = await seedNonAdmin("guest", "Guest");
      const { role, mod } = await seedRoleAndFolder("private");
      // Make author a member of the role so they can create + edit.
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: role.id, createdById: author.id } });

      const app = await buildServer(AUTH);
      const authorCookie = authCookie("author");
      const guestCookie = authCookie("guest");

      // Before grant: guest gets 403 PATCH.
      const before = await app.inject({
        method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie: guestCookie },
        payload: { contentMarkdown: "nope" },
      });
      expect(before.statusCode).toBe(403);

      // Author grants.
      const grant = await app.inject({
        method: "POST", url: `/api/articles/${a.id}/editors`, headers: { cookie: authorCookie },
        payload: { userId: guest.id },
      });
      expect(grant.statusCode).toBe(201);

      // After grant: guest can PATCH content.
      const after = await app.inject({
        method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie: guestCookie },
        payload: { contentMarkdown: "patched by collaborator" },
      });
      expect(after.statusCode).toBe(200);

      await app.close();
    });

    it("collaborator cannot grant additional editors (canManageEditors stays false)", async () => {
      const author = await seedNonAdmin("author", "Author");
      const collab = await seedNonAdmin("collab", "Collab");
      const stranger = await seedNonAdmin("stranger", "Stranger");
      const { role, mod } = await seedRoleAndFolder();
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: role.id, createdById: author.id } });
      await prisma.articleEditor.create({ data: { articleId: a.id, userId: collab.id, grantedBy: author.id } });

      const app = await buildServer(AUTH);
      const collabCookie = authCookie("collab");

      const res = await app.inject({
        method: "POST", url: `/api/articles/${a.id}/editors`, headers: { cookie: collabCookie },
        payload: { userId: stranger.id },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("collaborator cannot DELETE the article (delete is reserved for author + admin)", async () => {
      const author = await seedNonAdmin("author", "Author");
      const collab = await seedNonAdmin("collab", "Collab");
      const { role, mod } = await seedRoleAndFolder();
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: role.id, createdById: author.id } });
      await prisma.articleEditor.create({ data: { articleId: a.id, userId: collab.id, grantedBy: author.id } });

      const app = await buildServer(AUTH);
      const collabCookie = authCookie("collab");

      const res = await app.inject({ method: "DELETE", url: `/api/articles/${a.id}`, headers: { cookie: collabCookie } });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    // (已删除)「collaborator cannot change article status」用例:去状态后不存在
    // 状态变更这一动作;协作者可正常编辑内容(由其它用例覆盖)。

    it("admin can grant editors on any article", async () => {
      await seedAdmin();
      const author = await seedNonAdmin("author", "Author");
      const guest = await seedNonAdmin("guest", "Guest");
      const { role, mod } = await seedRoleAndFolder();
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: role.id, createdById: author.id } });

      const app = await buildServer(AUTH);
      const adminCookie = authCookie("admin");

      const res = await app.inject({
        method: "POST", url: `/api/articles/${a.id}/editors`, headers: { cookie: adminCookie },
        payload: { userId: guest.id },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  describe("DELETE /api/articles/:id/editors/:userId", () => {
    it("author can revoke; revoked user loses canEdit", async () => {
      const author = await seedNonAdmin("author", "Author");
      const collab = await seedNonAdmin("collab", "Collab");
      const { role, mod } = await seedRoleAndFolder();
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({ data: { title: "X", contentMarkdown: "y", folderId: mod.id, roleId: role.id, createdById: author.id } });
      await prisma.articleEditor.create({ data: { articleId: a.id, userId: collab.id, grantedBy: author.id } });

      const app = await buildServer(AUTH);
      const authorCookie = authCookie("author");
      const collabCookie = authCookie("collab");

      // Before revoke: collaborator can PATCH.
      const before = await app.inject({
        method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie: collabCookie },
        payload: { contentMarkdown: "ok" },
      });
      expect(before.statusCode).toBe(200);

      // Author revokes.
      const revoke = await app.inject({
        method: "DELETE", url: `/api/articles/${a.id}/editors/${collab.id}`, headers: { cookie: authorCookie },
      });
      expect(revoke.statusCode).toBe(204);

      // After revoke: collaborator gets 403 on PATCH.
      const after = await app.inject({
        method: "PATCH", url: `/api/articles/${a.id}`, headers: { cookie: collabCookie },
        payload: { contentMarkdown: "blocked" },
      });
      expect(after.statusCode).toBe(403);

      await app.close();
    });
  });

  describe("GET /api/users/search", () => {
    it("returns up-to-20 active users matching displayName, excluding self, never leaking email", async () => {
      const me = await seedNonAdmin("alice", "Alice");
      await prisma.user.create({ data: { ssoId: "bob", displayName: "Bob Builder", email: "bob@example.com" } });
      await seedNonAdmin("charlie", "Charlie");
      const app = await buildServer(AUTH);
      const cookie = authCookie("alice");

      const res = await app.inject({ method: "GET", url: "/api/users/search?q=ob", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { users: Array<{ id: string; displayName: string; avatarUrl: string | null; email?: unknown }> };
      // "Bob Builder" matches via displayName.
      const bob = body.users.find((u) => u.displayName === "Bob Builder");
      expect(bob).toBeTruthy();
      // Email must NOT be returned (PII leak fix).
      expect(bob).not.toHaveProperty("email");
      // Self never appears.
      expect(body.users.find((u) => u.id === me.id)).toBeUndefined();
      await app.close();
    });

    it("does NOT match on email (no email-directory enumeration)", async () => {
      await seedNonAdmin("alice", "Alice");
      await prisma.user.create({ data: { ssoId: "secret", displayName: "Zelda", email: "findme@example.com" } });
      const app = await buildServer(AUTH);
      const cookie = authCookie("alice");
      // Query a substring that only exists in the email, not any displayName.
      const res = await app.inject({ method: "GET", url: "/api/users/search?q=findme", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { users: unknown[] }).users).toHaveLength(0);
      await app.close();
    });

    it("400 on a single-char query (min length 2)", async () => {
      await seedNonAdmin("alice", "Alice");
      const app = await buildServer(AUTH);
      const cookie = authCookie("alice");
      const res = await app.inject({ method: "GET", url: "/api/users/search?q=a", headers: { cookie } });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("collaborator side-channels on a private-folder article", () => {
    // Shared scaffolding: author + collaborator on a published article
    // inside a private folder the collaborator has NO role in. Without
    // isCollaborator propagation, every endpoint below would 403 even
    // though the collaborator can PATCH the body via the editor ACL.
    async function setup() {
      const author = await seedNonAdmin("author", "Author");
      const collab = await seedNonAdmin("collab", "Collab");
      const { role, mod } = await seedRoleAndFolder("private");
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a = await prisma.article.create({
        data: { title: "Secret", contentMarkdown: "body", folderId: mod.id, roleId: role.id, createdById: author.id },
      });
      await prisma.articleEditor.create({ data: { articleId: a.id, userId: collab.id, grantedBy: author.id } });
      const app = await buildServer(AUTH);
      const cookie = authCookie("collab");
      return { app, cookie, articleId: a.id };
    }

    it("can fetch /versions while editing", async () => {
      const { app, cookie, articleId } = await setup();
      // Edit once so there's a version row to return.
      await app.inject({
        method: "PATCH", url: `/api/articles/${articleId}`, headers: { cookie },
        payload: { contentMarkdown: "edited by collab" },
      });
      const res = await app.inject({ method: "GET", url: `/api/articles/${articleId}/versions`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("can export the article they collaborate on", async () => {
      const { app, cookie, articleId } = await setup();
      const res = await app.inject({ method: "GET", url: `/api/articles/${articleId}/export`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("can like and comment on the article they collaborate on", async () => {
      const { app, cookie, articleId } = await setup();
      const like = await app.inject({ method: "POST", url: `/api/articles/${articleId}/like`, headers: { cookie } });
      expect(like.statusCode).toBe(200);
      const com = await app.inject({
        method: "POST", url: `/api/articles/${articleId}/comments`, headers: { cookie },
        payload: { body: "looks good" },
      });
      expect(com.statusCode).toBe(201);
      await app.close();
    });

    it("can bookmark the article they collaborate on", async () => {
      const { app, cookie, articleId } = await setup();
      const res = await app.inject({
        method: "POST", url: "/api/bookmarks", headers: { cookie }, payload: { articleId },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  describe("GET /api/me/collaborations", () => {
    it("returns articles where caller is in the editor ACL, excluding articles they authored", async () => {
      const author = await seedNonAdmin("author", "Author");
      const me = await seedNonAdmin("me", "Me");
      const { role, mod } = await seedRoleAndFolder();
      await prisma.userRole.create({ data: { userId: author.id, roleId: role.id } });
      const a1 = await prisma.article.create({ data: { title: "A1", contentMarkdown: "x", folderId: mod.id, roleId: role.id, createdById: author.id } });
      const a2 = await prisma.article.create({ data: { title: "A2", contentMarkdown: "x", folderId: mod.id, roleId: role.id, createdById: me.id } });
      await prisma.articleEditor.create({ data: { articleId: a1.id, userId: me.id, grantedBy: author.id } });

      const app = await buildServer(AUTH);
      const cookie = authCookie("me");

      const res = await app.inject({ method: "GET", url: "/api/me/collaborations", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { collaborations: { article: { id: string; title: string; permissions: { canEdit: boolean } } }[] };
      const ids = body.collaborations.map((c) => c.article.id);
      expect(ids).toContain(a1.id);
      expect(ids).not.toContain(a2.id);
      // canEdit must be true so the UI knows the row is editable.
      expect(body.collaborations[0]?.article.permissions.canEdit).toBe(true);
      await app.close();
    });
  });
});
