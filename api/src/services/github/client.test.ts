import { describe, it, expect, vi } from "vitest";
import { testConnection, fetchCommits, GithubError } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("github testConnection", () => {
  it("成功返回仓库信息,并带上 Bearer token + UA", async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse({ full_name: "me/app", private: true, default_branch: "main", pushed_at: "2026-06-10T00:00:00Z" }),
    );
    const info = await testConnection({ owner: "me", repo: "app", token: "tok" }, doFetch as unknown as typeof fetch);
    expect(info).toEqual({ fullName: "me/app", private: true, defaultBranch: "main", pushedAt: "2026-06-10T00:00:00Z" });
    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect((init.headers as Record<string, string>)["user-agent"]).toBeTruthy();
  });

  it("404 → not_found", async () => {
    const doFetch = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    await expect(testConnection({ owner: "x", repo: "y" }, doFetch as unknown as typeof fetch)).rejects.toMatchObject({
      name: "GithubError",
      code: "not_found",
    });
  });

  it("401 → unauthorized", async () => {
    const doFetch = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    await expect(testConnection({ owner: "x", repo: "y", token: "bad" }, doFetch as unknown as typeof fetch)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("无 token 时不带 Authorization 头", async () => {
    const doFetch = vi.fn(async () => jsonResponse({ full_name: "me/pub" }));
    await testConnection({ owner: "me", repo: "pub" }, doFetch as unknown as typeof fetch);
    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("网络异常 → GithubError network", async () => {
    const doFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const err = await testConnection({ owner: "x", repo: "y" }, doFetch as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).code).toBe("network");
  });
});

// 提交统计跨所有分支:fetchCommits 先 GET /branches 列分支,再对每个分支
// GET /commits?sha=<branch>,最后按 sha 去重。下面的 mock 按 URL 区分两类请求。
function branchListResponse(names: string[], opts: { nextLink?: string } = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.nextLink) headers.link = `<${opts.nextLink}>; rel="next"`;
  return new Response(JSON.stringify(names.map((name) => ({ name }))), { status: 200, headers });
}

describe("github fetchCommits", () => {
  it("枚举分支 → 按 sha 去重;映射首行/短 sha/作者,带 since&until&sha 查询", async () => {
    const commits = [
      { sha: "abcdef1234", commit: { message: "feat: 加登录\n\n正文", author: { name: "Alice", date: "2026-06-10T01:00:00Z" } }, author: { login: "octocat" } },
      { sha: "999", commit: { message: "fix: 崩溃", author: { name: "Alice", date: "2026-06-11T01:00:00Z" } }, author: null },
    ];
    const doFetch = vi.fn(async (url: string) =>
      url.includes("/branches") ? branchListResponse(["main"]) : jsonResponse(commits),
    );
    const result = await fetchCommits(
      { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z" },
      doFetch as unknown as typeof fetch,
    );
    expect(result.truncated).toBe(false);
    // 按提交时间倒序
    expect(result.commits).toEqual([
      { sha: "999", subject: "fix: 崩溃", author: "Alice", date: "2026-06-11T01:00:00Z" },
      { sha: "abcdef1", subject: "feat: 加登录", author: "octocat", date: "2026-06-10T01:00:00Z" },
    ]);
    const commitUrl = (doFetch.mock.calls.find((c) => (c[0] as string).includes("/commits"))![0]) as string;
    expect(commitUrl).toContain("since=");
    expect(commitUrl).toContain("until=");
    expect(commitUrl).toContain("sha=main");
    expect(doFetch).toHaveBeenCalledTimes(2); // 1 branches + 1 commits
  });

  it("多分支:同一 sha 在多个分支只算一次(去重)", async () => {
    const shared = { sha: "sharedsha", commit: { message: "feat: 共享", author: { name: "d", date: "2026-06-10T00:00:00Z" } }, author: { login: "d" } };
    const onlyDev = { sha: "devonly", commit: { message: "fix: dev", author: { name: "d", date: "2026-06-09T00:00:00Z" } }, author: { login: "d" } };
    const doFetch = vi.fn(async (url: string) => {
      if (url.includes("/branches")) return branchListResponse(["main", "dev"]);
      if (url.includes("sha=main")) return jsonResponse([shared]);
      return jsonResponse([shared, onlyDev]); // dev 分支
    });
    const result = await fetchCommits(
      { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z" },
      doFetch as unknown as typeof fetch,
    );
    expect(result.commits.map((c) => c.sha).sort()).toEqual(["devonly", "shareds"]); // 短 sha 截 7 位
    expect(result.commits).toHaveLength(2);
  });

  it("选了分支:跳过分支枚举,只查选中的分支", async () => {
    const commit = { sha: "abc1234", commit: { message: "feat: y", author: { name: "d", date: "2026-06-10T00:00:00Z" } }, author: { login: "d" } };
    const doFetch = vi.fn(async (url: string) => {
      if (url.includes("/branches")) throw new Error("不该枚举分支");
      return jsonResponse([commit]);
    });
    const r = await fetchCommits(
      { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z", branches: ["dev2.0"] },
      doFetch as unknown as typeof fetch,
    );
    expect(r.commits).toHaveLength(1);
    const [url] = doFetch.mock.calls[0] as unknown as [string];
    expect(url).toContain("sha=dev2.0");
  });

  it("选中的分支单个 404(已删)→ 跳过;全部 404 → 抛 not_found", async () => {
    const commit = { sha: "abc1234", commit: { message: "feat: y", author: { name: "d", date: "2026-06-10T00:00:00Z" } }, author: { login: "d" } };
    const doFetch = vi.fn(async (url: string) =>
      url.includes("sha=gone") ? jsonResponse({ message: "Not Found" }, 404) : jsonResponse([commit]),
    );
    const r = await fetchCommits(
      { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z", branches: ["gone", "main"] },
      doFetch as unknown as typeof fetch,
    );
    expect(r.commits).toHaveLength(1); // gone 被跳过,main 正常

    const all404 = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    await expect(
      fetchCommits(
        { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z", branches: ["a", "b"] },
        all404 as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("翻页:某分支第一页满 100 条时跟随 Link header 取第二页", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      sha: `sha${i}`,
      commit: { message: `commit ${i}`, author: { name: "dev", date: "2026-06-10T00:00:00Z" } },
      author: { login: "dev" },
    }));
    const page2 = [{ sha: "last", commit: { message: "last commit", author: { name: "dev", date: "2026-06-11T00:00:00Z" } }, author: { login: "dev" } }];
    const doFetch = vi.fn()
      .mockResolvedValueOnce(branchListResponse(["main"]))
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200, headers: { "content-type": "application/json", link: '<https://api.github.com/repos/me/app/commits?page=2>; rel="next"' } }))
      .mockResolvedValueOnce(jsonResponse(page2));
    const result = await fetchCommits(
      { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z" },
      doFetch as unknown as typeof fetch,
    );
    expect(doFetch).toHaveBeenCalledTimes(3); // 1 branches + 2 commit pages
    expect(result.commits).toHaveLength(101);
    expect(result.truncated).toBe(false);
  });

  it("翻页上限:单分支连续 5 页均满 100 条时停止并标注 truncated=true", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      sha: `sha${i}`,
      commit: { message: `commit ${i}`, author: { name: "dev", date: "2026-06-10T00:00:00Z" } },
      author: { login: "dev" },
    }));
    const body = JSON.stringify(fullPage);
    const doFetch = vi.fn(async (url: string) => {
      if (url.includes("/branches")) return branchListResponse(["main"]);
      // Each call must return a *fresh* Response — a single Response can only be read once.
      return new Response(body, { status: 200, headers: { "content-type": "application/json", link: '<https://api.github.com/repos/me/app/commits?page=2>; rel="next"' } });
    });
    const result = await fetchCommits(
      { owner: "me", repo: "app", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z" },
      doFetch as unknown as typeof fetch,
    );
    expect(doFetch).toHaveBeenCalledTimes(6); // 1 branches + 5 commit pages (capped)
    expect(result.commits).toHaveLength(100); // 同 sha across pages 去重后 100
    expect(result.truncated).toBe(true);
  });
});

describe("github fetch 超时", () => {
  it("请求挂住时被超时中止,抛 network 错误而不是一直挂着", async () => {
    vi.useFakeTimers();
    try {
      // 只在收到 abort 信号时才失败,模拟 GitHub 卡住
      const hang = ((_url: string, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
      const p = testConnection({ owner: "me", repo: "app" }, hang);
      const assertion = expect(p).rejects.toMatchObject({ code: "network" });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
