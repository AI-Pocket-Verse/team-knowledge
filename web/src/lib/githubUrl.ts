// 从用户粘贴的 GitHub 仓库地址解析出 owner / repo。容忍多种写法:
//   https://github.com/owner/repo            (可带 .git / 末尾斜杠 / /tree/... 等)
//   git@github.com:owner/repo.git            (SSH scp 形式)
//   owner/repo                               (裸写)
// 解析不出返回 null。
export function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const s = (input || "").trim();
  if (!s) return null;

  const clean = (owner?: string, repo?: string): { owner: string; repo: string } | null => {
    const o = (owner || "").trim();
    const r = (repo || "").replace(/\.git$/i, "").trim();
    return o && r ? { owner: o, repo: r } : null;
  };

  // SSH: git@github.com:owner/repo(.git)
  let m = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (m) return clean(m[1], m[2]);

  // https://github.com/owner/repo(...) — repo 截到下一个 / # ? 之前
  m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (m) return clean(m[1], m[2]);

  // 裸 owner/repo
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) return clean(m[1], m[2]);

  return null;
}
