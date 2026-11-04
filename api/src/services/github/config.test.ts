import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { addGithubRepo, removeGithubRepo, listGithubReposPublic, getGithubRepoById, getGithubRepos } from "./config.js";

describe("github config", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("新增后列表掩码不回传 token,但 hasToken 标记正确", async () => {
    await addGithubRepo({ owner: "me", repo: "pub" }, "admin");
    await addGithubRepo({ owner: "me", repo: "priv", label: "私有", token: "ghp_xxx" }, "admin");

    const pub = await listGithubReposPublic();
    expect(pub).toHaveLength(2);
    const priv = pub.find((r) => r.repo === "priv")!;
    expect(priv.label).toBe("私有");
    expect(priv.hasToken).toBe(true);
    expect((priv as unknown as Record<string, unknown>).token).toBeUndefined(); // 不回传
    const open = pub.find((r) => r.repo === "pub")!;
    expect(open.label).toBe("me/pub"); // 默认 owner/repo
    expect(open.hasToken).toBe(false);

    // token 仍存在底层(供拉取/测试用)。
    const stored = await getGithubRepos();
    expect(stored.find((r) => r.repo === "priv")?.token).toBe("ghp_xxx");
  });

  it("重复仓库(忽略大小写)报错", async () => {
    await addGithubRepo({ owner: "Me", repo: "App" }, "admin");
    await expect(addGithubRepo({ owner: "me", repo: "app" }, "admin")).rejects.toThrow("已配置");
  });

  it("删除按 id;不存在报错", async () => {
    const created = await addGithubRepo({ owner: "me", repo: "x" }, "admin");
    expect(await getGithubRepoById(created.id)).not.toBeNull();
    await removeGithubRepo(created.id, "admin");
    expect(await getGithubRepoById(created.id)).toBeNull();
    await expect(removeGithubRepo("nope", "admin")).rejects.toThrow("不存在");
  });

  it("owner/repo 必填", async () => {
    await expect(addGithubRepo({ owner: " ", repo: "x" }, "admin")).rejects.toThrow();
  });
});
