// 轻量 GitHub REST 客户端(只读):测试连接 + 拉取一段时间窗内的提交。无 token 走
// 未鉴权(限额 60/h),有 token 走 Bearer。依赖注入 fetch 便于单测。

const API = "https://api.github.com";

export class GithubError extends Error {
  constructor(public code: "not_found" | "unauthorized" | "rate_limited" | "network" | "upstream", message: string) {
    super(message);
    this.name = "GithubError";
  }
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "team-knowledge",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

const FETCH_TIMEOUT_MS = 15_000;

// 给每次请求加超时:GitHub 卡住时周报 / 测试连接不能一直挂着。
async function timedFetch(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await doFetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mapStatus(status: number, body: string): GithubError {
  if (status === 404) return new GithubError("not_found", "仓库不存在或无权访问(404)");
  if (status === 401) return new GithubError("unauthorized", "token 无效或权限不足(401)");
  if (status === 403) return new GithubError("rate_limited", "被限流或拒绝(403);私有仓库请配置 token");
  return new GithubError("upstream", `GitHub 返回 ${status}:${body.slice(0, 200)}`);
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

/** 测试连接:GET /repos/{owner}/{repo}。成功返回基本信息,失败抛 GithubError。 */
export async function testConnection(
  args: { owner: string; repo: string; token?: string },
  doFetch: typeof fetch = fetch,
): Promise<RepoInfo> {
  let res: Response;
  try {
    res = await timedFetch(doFetch, `${API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`, {
      headers: headers(args.token),
    });
  } catch (e) {
    throw new GithubError("network", `连接 GitHub 失败:${(e as Error).message}`);
  }
  if (!res.ok) throw mapStatus(res.status, await res.text().catch(() => ""));
  const j = (await res.json()) as { full_name?: string; private?: boolean; default_branch?: string; pushed_at?: string };
  return {
    fullName: j.full_name ?? `${args.owner}/${args.repo}`,
    private: !!j.private,
    defaultBranch: j.default_branch ?? "main",
    pushedAt: j.pushed_at ?? null,
  };
}

export interface CommitSummary {
  sha: string;
  subject: string; // 提交信息首行
  author: string;
  date: string;
}

export interface FetchCommitsResult {
  commits: CommitSummary[];
  /** true when the time window had ≥500 commits and we stopped early. */
  truncated: boolean;
}

/** Extract the URL for the next page from a GitHub Link header, if present. */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Link: <url>; rel="next", <url>; rel="last"
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1]! : null;
}

const PER_PAGE = 100;
const MAX_COMMIT_PAGES = 5; // 单分支最多翻 5 页(500 提交)防失控
const MAX_BRANCHES = 80; // 最多扫描多少个分支,防分支极多的仓库打爆 API

type RawCommit = {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
};

function parseRows(rows: RawCommit[]): CommitSummary[] {
  return rows.map((r) => ({
    sha: (r.sha ?? "").slice(0, 7),
    subject: (r.commit?.message ?? "").split("\n")[0]!.trim(),
    author: r.author?.login ?? r.commit?.author?.name ?? "unknown",
    date: r.commit?.author?.date ?? "",
  }));
}

/** 列出仓库所有分支名(分页,上限 MAX_BRANCHES)。返回 {branches, truncated}。
 *  后台「选择分支」面板与 fetchCommits 的全分支枚举共用。 */
export async function listBranches(
  args: { owner: string; repo: string; token?: string },
  doFetch: typeof fetch,
): Promise<{ branches: string[]; truncated: boolean }> {
  const branches: string[] = [];
  let url: string | null =
    `${API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/branches?per_page=${PER_PAGE}`;
  let truncated = false;
  while (url) {
    let res: Response;
    try {
      res = await timedFetch(doFetch, url, { headers: headers(args.token) });
    } catch (e) {
      throw new GithubError("network", `连接 GitHub 失败:${(e as Error).message}`);
    }
    if (!res.ok) throw mapStatus(res.status, await res.text().catch(() => ""));
    const rows = (await res.json()) as Array<{ name?: string }>;
    for (const r of rows) if (r.name) branches.push(r.name);
    if (branches.length >= MAX_BRANCHES) {
      branches.length = MAX_BRANCHES;
      truncated = true;
      console.warn(`[github] ${args.owner}/${args.repo}: 分支数 ≥${MAX_BRANCHES},只扫描前 ${MAX_BRANCHES} 个(truncated)`);
      break;
    }
    url = nextPageUrl(res.headers.get("link"));
  }
  return { branches, truncated };
}

/** 拉取某个分支 [sinceISO, untilISO] 窗口内的提交(分页,上限 MAX_COMMIT_PAGES)。 */
async function fetchCommitsForRef(
  args: { owner: string; repo: string; token?: string; sinceISO: string; untilISO: string; sha: string },
  doFetch: typeof fetch,
): Promise<{ commits: CommitSummary[]; truncated: boolean }> {
  const out: CommitSummary[] = [];
  let url: string | null =
    `${API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits` +
    `?sha=${encodeURIComponent(args.sha)}&since=${encodeURIComponent(args.sinceISO)}&until=${encodeURIComponent(args.untilISO)}&per_page=${PER_PAGE}`;
  let page = 0;
  let truncated = false;
  while (url && page < MAX_COMMIT_PAGES) {
    page++;
    let res: Response;
    try {
      res = await timedFetch(doFetch, url, { headers: headers(args.token) });
    } catch (e) {
      throw new GithubError("network", `连接 GitHub 失败:${(e as Error).message}`);
    }
    if (!res.ok) throw mapStatus(res.status, await res.text().catch(() => ""));
    const rows = (await res.json()) as RawCommit[];
    out.push(...parseRows(rows));
    if (rows.length < PER_PAGE) {
      url = null;
    } else {
      url = nextPageUrl(res.headers.get("link"));
      if (url && page >= MAX_COMMIT_PAGES) truncated = true;
    }
  }
  return { commits: out, truncated };
}

/** 拉取 [sinceISO, untilISO] 窗口内的提交(按 sha 去重)。
 *  `args.branches` 为空/缺省时枚举**所有分支**逐个拉取再合并 —— 团队本周的活儿常
 *  在 feature/dev 分支而非默认分支;选了分支则只统计选中的分支(单个分支已被删
 *  除时跳过;全部 404 视为仓库不可访问,照常抛错)。
 *  分支数 / 单分支提交数任一触顶都标注 truncated:true,调用方应告知用户数据不完整。 */
export async function fetchCommits(
  args: { owner: string; repo: string; token?: string; sinceISO: string; untilISO: string; branches?: string[] },
  doFetch: typeof fetch = fetch,
): Promise<FetchCommitsResult> {
  const selected = (args.branches ?? []).filter(Boolean);
  let branches: string[];
  let truncated = false;
  if (selected.length > 0) {
    branches = selected;
  } else {
    const all = await listBranches(args, doFetch);
    branches = all.branches;
    truncated = all.truncated;
  }
  // 仓库可能没有任何分支(空仓库)→ 直接返回空。
  if (branches.length === 0) return { commits: [], truncated };

  const bySha = new Map<string, CommitSummary>();
  let notFound = 0;
  let lastNotFound: GithubError | null = null;
  for (const branch of branches) {
    let r: { commits: CommitSummary[]; truncated: boolean };
    try {
      r = await fetchCommitsForRef({ ...args, sha: branch }, doFetch);
    } catch (e) {
      // 选中的分支可能已被删除(单分支 404 → 跳过);全部 404 多半是仓库本身
      // 不可访问,保留原错误抛出,别静默装作「本周无提交」。
      if (selected.length > 0 && e instanceof GithubError && e.code === "not_found") {
        notFound++;
        lastNotFound = e;
        continue;
      }
      throw e;
    }
    if (r.truncated) truncated = true;
    for (const c of r.commits) if (c.sha && !bySha.has(c.sha)) bySha.set(c.sha, c);
  }
  if (selected.length > 0 && notFound === selected.length && lastNotFound) throw lastNotFound;

  // 按提交时间倒序,贴近 git log 的观感。
  const commits = [...bySha.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return { commits, truncated };
}
