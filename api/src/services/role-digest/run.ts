// 周报装配的「跑数」层:拉 GitHub 本周提交 + LLM 简评,最后组装成飞书卡片。
// 把这段从 scripts/weekly-role-digest.ts 抽出来,好让定时脚本和后台「通知测试」
// 入口共用同一条真实链路 —— 测试发出的卡片与周五真发的完全一致(纯计算/组装在
// weekly.ts,这里只做有副作用的取数与 LLM)。
import {
  computeWeeklyRoleDigest, buildWeeklyDigestCard, dedupeSubjects,
  type RepoChange, type WeeklyDigest,
} from "./weekly.js";
import { getGithubRepos, toPublic } from "../github/config.js";
import { fetchCommits, GithubError } from "../github/client.js";
import { fetchCommitsSsh } from "../github/ssh.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import { L, appLang, type Lang } from "../../utils/lang.js";
import { outputLanguageInstruction } from "../llm/language.js";

const REVIEW_SYSTEM =
  "你是研发周报助手。根据下面各仓库本周的提交标题,用简体中文写 2-4 句话概括本周主要做了什么,并点出可量化的实质提升(如修复了什么、上线了什么功能、性能/稳定性改进)。" +
  "要概括,不要逐条复述提交;没有实质内容就只用一句话说明。直接输出正文,不要标题/前缀。";

/** 逐个拉取已配置仓库的本周提交(ssh 用本机密钥,token 走 REST)。单个仓库失败
 *  只在该条上标注 error,不影响其它仓库与知识库段。 */
export async function fetchRepoChanges(sinceISO: string, untilISO: string): Promise<RepoChange[]> {
  const repos = await getGithubRepos();
  const out: RepoChange[] = [];
  for (const r of repos) {
    const label = toPublic(r).label;
    try {
      // branches 缺省/空 = 全部分支;后台选过则只统计选中的分支。
      const { commits, truncated } = r.auth === "ssh"
        ? await fetchCommitsSsh({ owner: r.owner, repo: r.repo, sinceISO, untilISO, branches: r.branches })
        : await fetchCommits({ owner: r.owner, repo: r.repo, token: r.token, sinceISO, untilISO, branches: r.branches });
      out.push({ label, count: commits.length, subjects: dedupeSubjects(commits.map((c) => c.subject)), truncated });
    } catch (e) {
      const msg = e instanceof GithubError ? e.message : (e as Error).message;
      out.push({ label, count: 0, subjects: [], error: msg });
      console.warn(`[weekly-digest] 拉取 ${label} 失败:${msg}`);
    }
  }
  return out;
}

/** 用当前 LLM 提供方对所有提交标题写一段简评。无提交 / 失败 / 超时都降级为 null
 *  (周报「没有可以不说」)。 */
export async function llmReview(repos: RepoChange[]): Promise<string | null> {
  const lines = repos.filter((r) => !r.error).flatMap((r) => r.subjects.map((s) => `[${r.label}] ${s}`));
  if (lines.length === 0) return null;
  // 全局 LLM 并发闸(cron 独立进程内无竞争;经「发送测试」在服务进程里跑时,
  // 保证不挤占在线聊天)。繁忙降级为省略简评。
  let release: () => void;
  try {
    release = await chatSemaphore.acquire(30_000);
  } catch {
    console.warn("[weekly-digest] LLM 繁忙,简评降级省略");
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    const provider = await getProvider();
    let text = "";
    for await (const chunk of provider.chat({ systemPrompt: REVIEW_SYSTEM + outputLanguageInstruction(appLang()), history: [], userMessage: `本周提交:\n${lines.join("\n")}` }, ac.signal)) {
      if (chunk.type === "token") text += chunk.text;
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
    return text.trim() || null;
  } catch (e) {
    console.warn("[weekly-digest] LLM 简评失败,省略:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}

export interface WeeklyDigestResult {
  card: unknown;
  digest: WeeklyDigest;
  repos: RepoChange[];
  review: string | null;
}

/** 跑完整条周报链路:本周知识库变动 + GitHub 改动 + LLM 简评 → 飞书卡片。
 *  定时脚本与后台「通知测试」都调它,确保两边发出的卡片一字不差。 */
export async function generateWeeklyDigest(now: Date): Promise<WeeklyDigestResult> {
  const digest = await computeWeeklyRoleDigest(now);
  const repos = await fetchRepoChanges(digest.weekStart.toISOString(), now.toISOString());
  const review = await llmReview(repos);
  const card = buildWeeklyDigestCard(digest, { repos, review });
  return { card, digest, repos, review };
}
