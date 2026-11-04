// 管理后台可配置的 GitHub 仓库列表(用于周报「研发改动」统计)。存为单条 Setting
// 行 github.repos = JSON 数组。token 可选(私有仓库填,公开留空),与火山凭证同样
// 以明文存 Setting(本项目既有惯例,无加密工具);对外接口一律掩码不回传 token。
import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { getSetting, setSetting } from "../settings.js";

const KEY = "github.repos";

// 认证方式:
//   "token" — 走 GitHub REST API(可选 PAT,公开库可留空)。
//   "ssh"   — 走 git over SSH,用运行环境(本机/服务器)已有的 SSH 私钥,
//             不在应用层存任何密钥。私有库且机器 key 已有权时最省事。
export type GithubAuth = "token" | "ssh";

export interface GithubRepo {
  id: string;
  owner: string;
  repo: string;
  label?: string; // 展示名,默认 owner/repo
  auth?: GithubAuth; // 缺省视为 "token"(兼容旧数据)
  token?: string; // 可选 PAT(仅 token 方式;ssh 方式不存)
  /** 周报只统计这些分支;缺省/空数组 = 全部分支(兼容旧数据 + 安全默认)。 */
  branches?: string[];
}

/** 对外安全视图:不含 token,只标记是否已配置。 */
export interface GithubRepoPublic {
  id: string;
  owner: string;
  repo: string;
  label: string;
  auth: GithubAuth;
  hasToken: boolean;
  /** 已选分支;空数组 = 全部分支。 */
  branches: string[];
}

export function toPublic(r: GithubRepo): GithubRepoPublic {
  return {
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    label: r.label?.trim() || `${r.owner}/${r.repo}`,
    auth: r.auth ?? "token",
    hasToken: !!r.token,
    branches: r.branches ?? [],
  };
}

export async function getGithubRepos(): Promise<GithubRepo[]> {
  return getSetting<GithubRepo[]>(KEY, []);
}

export async function listGithubReposPublic(): Promise<GithubRepoPublic[]> {
  return (await getGithubRepos()).map(toPublic);
}

export async function addGithubRepo(
  input: { owner: string; repo: string; label?: string; auth?: GithubAuth; token?: string },
  updatedBy: string,
): Promise<GithubRepoPublic> {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  if (!owner || !repo) throw new Error("owner / repo 必填");
  const auth: GithubAuth = input.auth === "ssh" ? "ssh" : "token";
  // Wrap read-modify-write in a transaction to serialise concurrent requests
  // (SQLite's single-writer model turns this into a mutex; on other DBs the
  // transaction still prevents lost-update races via row locking).
  const next: GithubRepo = {
    id: randomUUID(),
    owner,
    repo,
    label: input.label?.trim() || undefined,
    auth,
    // SSH 方式不存 token;token 方式才保留。
    token: auth === "token" ? input.token?.trim() || undefined : undefined,
  };
  await prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: KEY } });
    const repos: GithubRepo[] = row ? (JSON.parse(row.value) as GithubRepo[]) : [];
    if (repos.some((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase())) {
      throw new Error("该仓库已配置");
    }
    const encoded = JSON.stringify([...repos, next]);
    await tx.setting.upsert({ where: { key: KEY }, update: { value: encoded, updatedBy }, create: { key: KEY, value: encoded, updatedBy } });
  });
  return toPublic(next);
}

export async function removeGithubRepo(id: string, updatedBy: string): Promise<void> {
  // Wrap read-modify-write in a transaction (same rationale as addGithubRepo).
  await prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: KEY } });
    const repos: GithubRepo[] = row ? (JSON.parse(row.value) as GithubRepo[]) : [];
    const next = repos.filter((r) => r.id !== id);
    if (next.length === repos.length) throw new Error("仓库不存在");
    const encoded = JSON.stringify(next);
    await tx.setting.upsert({ where: { key: KEY }, update: { value: encoded, updatedBy }, create: { key: KEY, value: encoded, updatedBy } });
  });
}

export async function getGithubRepoById(id: string): Promise<GithubRepo | null> {
  return (await getGithubRepos()).find((r) => r.id === id) ?? null;
}

/** 更新某仓库的「周报统计分支」。空数组 = 恢复全部分支(存为缺省)。
 *  事务内读-改-写,与 add/remove 同样防并发丢更新。 */
export async function updateGithubRepoBranches(
  id: string,
  branches: string[],
  updatedBy: string,
): Promise<GithubRepoPublic> {
  const cleaned = [...new Set(branches.map((b) => b.trim()).filter(Boolean))];
  let updated: GithubRepo | null = null;
  await prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: KEY } });
    const repos: GithubRepo[] = row ? (JSON.parse(row.value) as GithubRepo[]) : [];
    const target = repos.find((r) => r.id === id);
    if (!target) throw new Error("仓库不存在");
    target.branches = cleaned.length > 0 ? cleaned : undefined;
    updated = target;
    const encoded = JSON.stringify(repos);
    await tx.setting.upsert({ where: { key: KEY }, update: { value: encoded, updatedBy }, create: { key: KEY, value: encoded, updatedBy } });
  });
  return toPublic(updated!);
}
