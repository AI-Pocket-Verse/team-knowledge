import { describe, it, expect, vi } from "vitest";
import { sshUrl, parseGitLog, testConnectionSsh, fetchCommitsSsh, listBranchesSsh } from "./ssh.js";
import { GithubError } from "./client.js";

const FS = "\x1f"; // field sep
const RS = "\x1e"; // record sep

describe("github ssh helpers", () => {
  it("sshUrl 拼出 scp 形式", () => {
    expect(sshUrl("example-org", "example-repo")).toBe("git@github.com:example-org/example-repo.git");
  });

  it("parseGitLog 解析机读输出(短 sha / 首行 / 作者 / 日期)", () => {
    const out =
      `abcdef1234567${FS}feat: 加登录${FS}octocat${FS}2026-06-10T01:00:00+08:00${RS}` +
      `999${FS}fix: 崩溃\n第二行正文${FS}wen${FS}2026-06-11T02:00:00+08:00${RS}`;
    expect(parseGitLog(out)).toEqual([
      { sha: "abcdef1", subject: "feat: 加登录", author: "octocat", date: "2026-06-10T01:00:00+08:00" },
      { sha: "999", subject: "fix: 崩溃", author: "wen", date: "2026-06-11T02:00:00+08:00" },
    ]);
  });

  it("parseGitLog 空输出 → 空数组", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  it("testConnectionSsh:ls-remote 返回 HEAD → 短 sha", async () => {
    const exec = vi.fn(async () => "dddf6070240dcf8614ad5c0c4a0e35870d1f682b\tHEAD\n");
    const info = await testConnectionSsh({ owner: "example-org", repo: "example-repo" }, exec);
    expect(info).toEqual({ fullName: "example-org/example-repo", head: "dddf607" });
    expect(exec).toHaveBeenCalledWith(["ls-remote", "git@github.com:example-org/example-repo.git", "HEAD"]);
  });

  it("testConnectionSsh:Permission denied → unauthorized", async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error("x"), { stderr: "git@github.com: Permission denied (publickey)." }); });
    const err = await testConnectionSsh({ owner: "o", repo: "r" }, exec).catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).code).toBe("unauthorized");
  });

  it("testConnectionSsh:Repository not found → not_found", async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error("x"), { stderr: "ERROR: Repository not found." }); });
    const err = await testConnectionSsh({ owner: "o", repo: "r" }, exec).catch((e) => e);
    expect((err as GithubError).code).toBe("not_found");
  });

  it("listBranchesSsh:ls-remote --heads → 分支名列表", async () => {
    const exec = vi.fn(async () =>
      "aaa\trefs/heads/main\nbbb\trefs/heads/dev2.0\nccc\trefs/heads/feature/login\n",
    );
    const branches = await listBranchesSsh({ owner: "o", repo: "r" }, exec);
    expect(branches).toEqual(["main", "dev2.0", "feature/login"]);
    expect(exec).toHaveBeenCalledWith(["ls-remote", "--heads", "git@github.com:o/r.git"]);
  });

  it("fetchCommitsSsh:选了分支 → git log 只带选中且仍存在的分支", async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === "clone") return "";
      if (args.includes("for-each-ref")) return "main\ndev2.0\n"; // 远端实际分支
      return `aaaaaaa1${FS}feat: x${FS}dev${FS}2026-06-10T00:00:00Z${RS}`;
    });
    const r = await fetchCommitsSsh(
      { owner: "o", repo: "r", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z", branches: ["dev2.0", "gone-branch"] },
      exec,
    );
    expect(r.commits).toHaveLength(1);
    const logArgs = exec.mock.calls.find((c) => (c[0] as string[]).includes("log"))![0] as string[];
    expect(logArgs).toContain("dev2.0");        // 选中且存在 → 统计
    expect(logArgs).not.toContain("gone-branch"); // 选中但远端已删 → 跳过
    expect(logArgs).not.toContain("--branches");  // 不再全分支
  });

  it("fetchCommitsSsh:选中的分支全部已被删除 → 空结果而非报错", async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === "clone") return "";
      if (args.includes("for-each-ref")) return "main\n";
      throw new Error("git log 不该被调用");
    });
    const r = await fetchCommitsSsh(
      { owner: "o", repo: "r", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z", branches: ["gone"] },
      exec,
    );
    expect(r).toEqual({ commits: [], truncated: false });
  });

  it("fetchCommitsSsh:clone(blobless 全分支)后 git log --branches,解析提交", async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === "clone") return ""; // clone 成功
      // git -C <dir> log ...
      return `aaaaaaa1${FS}feat: x${FS}dev${FS}2026-06-10T00:00:00Z${RS}`;
    });
    const r = await fetchCommitsSsh({ owner: "o", repo: "r", sinceISO: "2026-06-08T00:00:00Z", untilISO: "2026-06-12T00:00:00Z" }, exec);
    expect(r.truncated).toBe(false);
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0]!.subject).toBe("feat: x");
    // 用了 blobless clone,且 NOT 单分支(要统计所有分支)
    const cloneArgs = exec.mock.calls[0]![0] as string[];
    expect(cloneArgs).toContain("--filter=blob:none");
    expect(cloneArgs).not.toContain("--single-branch");
    expect(cloneArgs).toContain("git@github.com:o/r.git");
    // git log 跨所有分支
    const logArgs = exec.mock.calls[1]![0] as string[];
    expect(logArgs).toContain("--branches");
    expect(logArgs).toContain("--no-merges");
  });
});
