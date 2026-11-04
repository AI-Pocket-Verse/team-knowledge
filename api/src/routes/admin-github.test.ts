import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { disconnectDb } from "../db.js";
import { resetDb, seedAdmin, seedUser, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("/api/admin/github", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { await disconnectDb(); });

  it("非管理员 → 403", async () => {
    await seedUser({ ssoId: "u2", isAdmin: false });
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/api/admin/github/repos", headers: { cookie: authCookie("u2") } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("管理员可新增 → 列表掩码 → 删除", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const add = await app.inject({
      method: "POST", url: "/api/admin/github/repos",
      headers: { cookie, "content-type": "application/json" },
      payload: { owner: "me", repo: "app", token: "ghp_secret" },
    });
    expect(add.statusCode).toBe(201);
    const id = add.json().repo.id;
    expect(add.json().repo.hasToken).toBe(true);
    expect(add.json().repo.token).toBeUndefined(); // 不回传 token

    const list = await app.inject({ method: "GET", url: "/api/admin/github/repos", headers: { cookie } });
    expect(list.json().repos).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain("ghp_secret"); // token 永不出现在响应

    const del = await app.inject({ method: "DELETE", url: `/api/admin/github/repos/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: "GET", url: "/api/admin/github/repos", headers: { cookie } });
    expect(list2.json().repos).toHaveLength(0);
    await app.close();
  });

  it("owner / repo 含非法字符 → 400 invalid_github_repo;repo 末尾 .git 去掉后保存", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie, "content-type": "application/json" }, payload });

    for (const bad of [
      { owner: "me/evil", repo: "app" },
      { owner: "me", repo: "app;rm -rf" },
      { owner: "me", repo: "a b" },
      { owner: "-o", repo: "app\nx" },
      { owner: "me", repo: ".." },
      { owner: "me", repo: ".git" },
    ]) {
      for (const url of ["/api/admin/github/repos", "/api/admin/github/test"]) {
        const res = await post(url, { ...bad, token: "t" });
        expect(res.statusCode, `${url} ${JSON.stringify(bad)}`).toBe(400);
        expect(res.json().error).toBe("invalid_github_repo");
        expect(res.json().message).toContain("仓库");
      }
    }

    const ok = await post("/api/admin/github/repos", { owner: "me", repo: "app.git", token: "t" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().repo.repo).toBe("app");
    await app.close();
  });

  it("分支:GET 列出远端分支(token 路径),PATCH 保存选中分支并回读;空数组恢复全部", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const add = await app.inject({
      method: "POST", url: "/api/admin/github/repos",
      headers: { cookie, "content-type": "application/json" },
      payload: { owner: "me", repo: "app" },
    });
    const id = add.json().repo.id;
    expect(add.json().repo.branches).toEqual([]); // 默认 = 全部分支

    // GET branches:REST /branches 返回两个分支
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([{ name: "main" }, { name: "dev2.0" }]), { status: 200, headers: { "content-type": "application/json" } }),
    ));
    const list = await app.inject({ method: "GET", url: `/api/admin/github/repos/${id}/branches`, headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ branches: ["main", "dev2.0"], selected: [] });

    // PATCH 保存选中分支
    const patch = await app.inject({
      method: "PATCH", url: `/api/admin/github/repos/${id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { branches: ["dev2.0"] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().repo.branches).toEqual(["dev2.0"]);
    const repos = await app.inject({ method: "GET", url: "/api/admin/github/repos", headers: { cookie } });
    expect(repos.json().repos[0].branches).toEqual(["dev2.0"]);

    // 空数组 = 恢复全部
    const clear = await app.inject({
      method: "PATCH", url: `/api/admin/github/repos/${id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { branches: [] },
    });
    expect(clear.json().repo.branches).toEqual([]);

    // 不存在的仓库 → 404
    const nf = await app.inject({
      method: "PATCH", url: "/api/admin/github/repos/nope",
      headers: { cookie, "content-type": "application/json" },
      payload: { branches: ["main"] },
    });
    expect(nf.statusCode).toBe(404);
    await app.close();
  });

  it("测试连接(临时):成功 → ok + info", async () => {
    await seedAdmin();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ full_name: "me/app", private: false, default_branch: "main", pushed_at: null }), { status: 200 }),
    ));
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/admin/github/test",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { owner: "me", repo: "app" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().fullName).toBe("me/app");
    expect(res.json().detail).toContain("默认分支");
    await app.close();
  });

  it("测试连接(临时):404 → 404 + 错误信息", async () => {
    await seedAdmin();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const app = await buildServer(AUTH);
    const res = await app.inject({
      method: "POST", url: "/api/admin/github/test",
      headers: { cookie: authCookie("admin"), "content-type": "application/json" },
      payload: { owner: "x", repo: "y" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
    await app.close();
  });

  it("测试已存仓库 → 用存储 token 连接", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const add = await app.inject({
      method: "POST", url: "/api/admin/github/repos",
      headers: { cookie, "content-type": "application/json" },
      payload: { owner: "me", repo: "priv", token: "ghp_stored" },
    });
    const id = add.json().repo.id;

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ full_name: "me/priv", private: true, default_branch: "main" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const res = await app.inject({ method: "POST", url: `/api/admin/github/repos/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // 用了存储的 token。
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_stored");
    await app.close();
  });
});
