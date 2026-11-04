// git over SSH 读取仓库历史(私有库免 token:用运行环境已有的 SSH 私钥)。
// 测试连接 = `git ls-remote`(秒级,只验证连通+有权);取本周提交 = 一次性
// blobless 单分支 clone 到临时目录(只下载提交/树元数据、无文件内容)后 git log,
// 用完即删。不在应用层存任何密钥。
//
// 选用 blobless(--filter=blob:none)而非 --shallow-since:后者在「窗口内无提交」
// 时会 clone 失败(fatal: no commits selected),每个安静的周都会误报失败。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubError, type CommitSummary, type FetchCommitsResult } from "./client.js";

const execFileP = promisify(execFile);

export function sshUrl(owner: string, repo: string): string {
  return `git@github.com:${owner}/${repo}.git`;
}

// 非交互、自动接受新 host key、禁止任何口令提示挂起。可被外部 GIT_SSH_COMMAND 覆盖。
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** 注入式 git 执行器(便于单测):返回 stdout,失败抛带 stderr 的错误。 */
export type GitExec = (args: string[]) => Promise<string>;

const realGit: GitExec = async (args) => {
  const { stdout } = await execFileP("git", args, {
    env: gitEnv(),
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

function mapGitError(e: unknown): GithubError {
  const msg = (e as { stderr?: string; message?: string }).stderr || (e as Error).message || "";
  if (/permission denied|publickey|access denied/i.test(msg)) {
    return new GithubError("unauthorized", "SSH 密钥无权访问该仓库(Permission denied)");
  }
  if (/repository not found|does not exist|not found/i.test(msg)) {
    return new GithubError("not_found", "仓库不存在或该 SSH 密钥无权访问");
  }
  return new GithubError("network", `git over SSH 失败:${msg.split("\n")[0]?.slice(0, 200) ?? "unknown"}`);
}

export interface SshRepoInfo {
  fullName: string;
  head: string; // HEAD commit sha(短)
}

/** 测试连接:git ls-remote <ssh-url> HEAD。成功返回 HEAD 短 sha。 */
export async function testConnectionSsh(
  args: { owner: string; repo: string },
  exec: GitExec = realGit,
): Promise<SshRepoInfo> {
  let out: string;
  try {
    out = await exec(["ls-remote", sshUrl(args.owner, args.repo), "HEAD"]);
  } catch (e) {
    throw mapGitError(e);
  }
  const sha = out.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new GithubError("upstream", "ls-remote 未返回有效的 HEAD");
  }
  return { fullName: `${args.owner}/${args.repo}`, head: sha.slice(0, 7) };
}

/** 列出远端全部分支名:git ls-remote --heads。用于后台「选择分支」面板。 */
export async function listBranchesSsh(
  args: { owner: string; repo: string },
  exec: GitExec = realGit,
): Promise<string[]> {
  let out: string;
  try {
    out = await exec(["ls-remote", "--heads", sshUrl(args.owner, args.repo)]);
  } catch (e) {
    throw mapGitError(e);
  }
  // 每行 "<sha>\trefs/heads/<name>"
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length));
}

const REC_SEP = "\x1e"; // 记录分隔(每个提交一条)
const FIELD_SEP = "\x1f"; // 字段分隔

/** 解析 git log 的机读输出(纯函数,便于单测)。 */
export function parseGitLog(stdout: string): CommitSummary[] {
  return stdout
    .split(REC_SEP)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha = "", subject = "", author = "", date = ""] = rec.split(FIELD_SEP);
      return { sha: sha.slice(0, 7), subject: subject.split("\n")[0]!.trim(), author: author || "unknown", date };
    });
}

/** 取 [sinceISO, untilISO] 窗口内的提交(blobless clone → git log)。
 *  `branches` 为空/缺省时跨**所有分支**统计(--branches)—— 团队本周的活儿常在
 *  feature/dev 分支上,默认分支(main)可能整周没动;选了分支则只统计选中的
 *  分支(与远端实际存在的分支取交集,选中的分支已被删除时自动跳过)。
 *  git log 会按 sha 自动去重,同一提交被多个分支引用也只算一次;--no-merges
 *  滤掉 PR 合并提交噪声。clone 不加 --single-branch(要拿到全部分支的 ref)。 */
export async function fetchCommitsSsh(
  args: { owner: string; repo: string; sinceISO: string; untilISO: string; branches?: string[] },
  exec: GitExec = realGit,
): Promise<FetchCommitsResult> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-gitdigest-"));
  try {
    await exec(["clone", "--bare", "--no-tags", "--filter=blob:none", sshUrl(args.owner, args.repo), dir]);
    let refArgs: string[] = ["--branches"];
    if (args.branches && args.branches.length > 0) {
      // 与本地实际 ref 取交集:选中的分支可能已在远端被删,直接传给 git log 会报
      // unknown revision 拖垮整个仓库的统计。
      const refsOut = await exec(["-C", dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
      const existing = new Set(refsOut.split("\n").map((s) => s.trim()).filter(Boolean));
      refArgs = args.branches.filter((b) => existing.has(b));
      if (refArgs.length === 0) return { commits: [], truncated: false };
    }
    const fmt = `--pretty=format:%H${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%aI${REC_SEP}`;
    const stdout = await exec(["-C", dir, "log", ...refArgs, `--since=${args.sinceISO}`, `--until=${args.untilISO}`, "--no-merges", fmt]);
    return { commits: parseGitLog(stdout), truncated: false };
  } catch (e) {
    throw mapGitError(e);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
