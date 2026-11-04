import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { prisma, disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";
import { flushBestEffortWrites } from "../utils/guards.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

async function seedArticle() {
  const u = await seedAdmin();
  const role = await prisma.role.create({ data: { name: "产品" } });
  const fold = await prisma.folder.create({ data: { name: "M", roleId: role.id, visibility: "public" } });
  const a = await prisma.article.create({
    data: { title: "T", contentMarkdown: "body", folderId: fold.id, roleId: fold.roleId, createdById: u.id },
  });
  return { user: u, article: a };
}

describe("POST/DELETE /api/articles/:id/like", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("first POST adds the like; second is idempotent and stays at count 1", async () => {
    const { article } = await seedArticle();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r1 = await app.inject({ method: "POST", url: `/api/articles/${article.id}/like`, headers: { cookie } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ isLiked: true, likeCount: 1 });
    const r2 = await app.inject({ method: "POST", url: `/api/articles/${article.id}/like`, headers: { cookie } });
    expect(r2.json()).toEqual({ isLiked: true, likeCount: 1 });
    await app.close();
  });

  it("DELETE removes the like; second DELETE is also idempotent", async () => {
    const { article, user } = await seedArticle();
    await prisma.like.create({ data: { userId: user.id, articleId: article.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const r1 = await app.inject({ method: "DELETE", url: `/api/articles/${article.id}/like`, headers: { cookie } });
    expect(r1.json()).toEqual({ isLiked: false, likeCount: 0 });
    const r2 = await app.inject({ method: "DELETE", url: `/api/articles/${article.id}/like`, headers: { cookie } });
    expect(r2.json()).toEqual({ isLiked: false, likeCount: 0 });
    await app.close();
  });
});

describe("/api/articles/:id/comments + DELETE /api/comments/:id", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("POST creates a comment; GET returns it; DELETE removes it (author)", async () => {
    const { article } = await seedArticle();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const post = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`, headers: { cookie },
      payload: { body: "first 👋" },
    });
    expect(post.statusCode).toBe(201);
    const created = post.json().comment;
    expect(created.body).toBe("first 👋");
    expect(created.canDelete).toBe(true);

    const list = await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie } });
    expect(list.json().comments).toHaveLength(1);

    const del = await app.inject({ method: "DELETE", url: `/api/comments/${created.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie } });
    expect(list2.json().comments).toHaveLength(0);
    await app.close();
  });

  it("bounds top-level comments to 200/page and pages the rest via nextCursor", async () => {
    const { article, user } = await seedArticle();
    // 201 top-level comments → page 1 caps at 200 with a real nextCursor;
    // page 2 (via ?cursor=) returns the remaining 1. createdAt is set
    // explicitly so keyset ordering is deterministic across the boundary.
    const base = Date.now();
    for (let i = 0; i < 201; i++) {
      await prisma.comment.create({
        data: { articleId: article.id, authorId: user.id, body: `c${i}`, createdAt: new Date(base + i) },
      });
    }
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const p1 = (await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie } })).json();
    expect(p1.comments).toHaveLength(200);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = (await app.inject({
      method: "GET",
      url: `/api/articles/${article.id}/comments?cursor=${p1.nextCursor}`,
      headers: { cookie },
    })).json();
    expect(p2.comments).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    await app.close();
  });

  it("nests replies under their top-level parent on the comments page", async () => {
    const { article, user } = await seedArticle();
    const parent = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "top" } });
    await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "reply", parentId: parent.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const list = (await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie } })).json();
    expect(list.comments).toHaveLength(1);
    expect(list.comments[0].replies).toHaveLength(1);
    expect(list.comments[0].replies[0].body).toBe("reply");
    await app.close();
  });

  it("多级回复:可以回复一条回复;GET 返回逐级嵌套的树且 parentId 保留", async () => {
    const { article, user } = await seedArticle();
    const top = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "顶层" } });
    const r1 = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "一级回复", parentId: top.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    // 回复「一级回复」(parent 本身是回复)→ 201,不再被 400 拒绝。
    const post = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`, headers: { cookie },
      payload: { body: "二级回复", parentId: r1.id },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().comment.parentId).toBe(r1.id);
    await flushBestEffortWrites();

    // 再往下回一层(三级),验证任意深度。
    const r2Id = post.json().comment.id as string;
    const post3 = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`, headers: { cookie },
      payload: { body: "三级回复", parentId: r2Id },
    });
    expect(post3.statusCode).toBe(201);
    await flushBestEffortWrites();

    // GET:逐级嵌套(一级.replies=[二级],二级.replies=[三级]),parentId 指向真实父。
    const list = (await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie } })).json();
    expect(list.comments).toHaveLength(1);
    type ReplyNode = { body: string; parentId: string; replies: ReplyNode[] };
    const lv1 = list.comments[0].replies as ReplyNode[];
    expect(lv1).toHaveLength(1);
    expect(lv1[0]!.body).toBe("一级回复");
    expect(lv1[0]!.replies).toHaveLength(1);
    expect(lv1[0]!.replies[0]!.body).toBe("二级回复");
    expect(lv1[0]!.replies[0]!.parentId).toBe(r1.id);
    expect(lv1[0]!.replies[0]!.replies[0]!.body).toBe("三级回复");
    expect(lv1[0]!.replies[0]!.replies[0]!.parentId).toBe(r2Id);
    await app.close();
  });

  it("删除中间层回复会级联删除其子孙(FK Cascade),顶层与旁支保留", async () => {
    const { article, user } = await seedArticle();
    const top = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "顶层" } });
    const r1 = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "一级", parentId: top.id } });
    await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "二级", parentId: r1.id } });
    const side = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "旁支", parentId: top.id } });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const del = await app.inject({ method: "DELETE", url: `/api/comments/${r1.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);

    const list = (await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie } })).json();
    const replies = list.comments[0].replies as Array<{ id: string; body: string }>;
    expect(replies.map((r) => r.body)).toEqual(["旁支"]);
    expect(replies[0]!.id).toBe(side.id);
    await app.close();
  });

  it("persists @mentions and notifies the mentioned user (comment_mention)", async () => {
    const { article } = await seedArticle(); // admin authors, published
    const mentioned = await seedUser({ ssoId: "m1", displayName: "李四" });
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const post = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`, headers: { cookie },
      payload: { body: `看看 [@李四](/u/${mentioned.id})` },
    });
    expect(post.statusCode).toBe(201);
    const created = post.json().comment;

    // mention row written synchronously as part of creating the comment
    const mention = await prisma.commentMention.findUnique({
      where: { commentId_userId: { commentId: created.id, userId: mentioned.id } },
    });
    expect(mention).toBeTruthy();

    // notification is fire-and-forget → drain before asserting
    await flushBestEffortWrites();
    const notif = await prisma.notification.findFirst({
      where: { recipientId: mentioned.id, type: "comment_mention" },
    });
    expect(notif).toBeTruthy();
    await app.close();
  });

  it("rejects empty body (400) and oversize body (413)", async () => {
    const { article } = await seedArticle();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const empty = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`, headers: { cookie },
      payload: { body: "   " },
    });
    expect(empty.statusCode).toBe(400);
    const big = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`, headers: { cookie },
      payload: { body: "x".repeat(5000) },
    });
    expect(big.statusCode).toBe(413);
    await app.close();
  });
});

describe("GET comments 回复不受整篇文档回复总数影响", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("第 1 条顶层评论有 1000+ 条回复时,同页第 2 条顶层评论的新回复仍可见", async () => {
    const { article, user } = await seedArticle();
    const base = Date.now();
    const c1 = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "c1", createdAt: new Date(base) } });
    const c2 = await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "c2", createdAt: new Date(base + 1) } });
    await prisma.comment.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        articleId: article.id, authorId: user.id, body: `r${i}`, parentId: c1.id, createdAt: new Date(base + 10 + i),
      })),
    });
    await prisma.comment.create({ data: { articleId: article.id, authorId: user.id, body: "late-reply", parentId: c2.id, createdAt: new Date(base + 5000) } });
    const app = await buildServer(AUTH);
    const list = (await app.inject({ method: "GET", url: `/api/articles/${article.id}/comments`, headers: { cookie: authCookie("admin") } })).json();
    const got2 = list.comments.find((c: { id: string }) => c.id === c2.id);
    expect(got2.replies.map((r: { body: string }) => r.body)).toEqual(["late-reply"]);
    await app.close();
  });
});

describe("POST comments body 非字符串", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("body 为数字 → 400 invalid_input(不是 500)", async () => {
    const { article } = await seedArticle();
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: `/api/articles/${article.id}/comments`,
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { body: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    await app.close();
  });
});

