// 管理后台:GitHub 仓库配置(供周报「研发改动」统计)。仅管理员。
// - GET    /api/admin/github/repos                列表(掩码,不回传 token)
// - POST   /api/admin/github/repos                新增 { owner, repo, label?, token? }
// - DELETE /api/admin/github/repos/:id            删除
// - GET    /api/admin/github/repos/:id/branches   列出该仓库远端全部分支(选分支面板用)
// - PATCH  /api/admin/github/repos/:id            更新统计分支 { branches }(空 = 全部)
// - POST   /api/admin/github/repos/:id/test       测试已存仓库(用存储的 token)
// - POST   /api/admin/github/test                 临时测试(新增表单用,token 现填现测)
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../utils/guards.js";
import { addGithubRepo, removeGithubRepo, listGithubReposPublic, getGithubRepoById, updateGithubRepoBranches, type GithubAuth } from "../services/github/config.js";
import { testConnection, listBranches, GithubError } from "../services/github/client.js";
import { testConnectionSsh, listBranchesSsh } from "../services/github/ssh.js";

const addSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  label: z.string().max(100).optional(),
  auth: z.enum(["token", "ssh"]).optional(),
  token: z.string().max(255).optional(),
});
const testSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  auth: z.enum(["token", "ssh"]).optional(),
  token: z.string().max(255).optional(),
});

// owner / repo 只允许 GitHub 名称字符;repo 先去掉末尾 .git 再校验(并按去掉后的名字保存)。
// 纯点号("." / "..")会被当成路径片段,一并拒绝。
const GH_NAME = /^[A-Za-z0-9._-]+$/;
function checkRepoRef<T extends { owner: string; repo: string }>(input: T, reply: FastifyReply): T | null {
  const owner = input.owner.trim();
  const repo = input.repo.trim().replace(/\.git$/i, "");
  const ok = (n: string) => GH_NAME.test(n) && !/^\.+$/.test(n);
  if (!ok(owner) || !ok(repo)) {
    reply.code(400).send({
      error: "invalid_github_repo",
      message: "仓库所有者或仓库名只能包含字母、数字、点、下划线和连字符",
    });
    return null;
  }
  return { ...input, owner, repo };
}

// 统一测试结果:token / ssh 两种方式都归一为 { fullName, detail },前端无需关心差异。
async function runTest(args: { owner: string; repo: string; auth?: GithubAuth; token?: string }): Promise<{ fullName: string; detail: string }> {
  if (args.auth === "ssh") {
    const info = await testConnectionSsh({ owner: args.owner, repo: args.repo });
    return { fullName: info.fullName, detail: `SSH · HEAD ${info.head}` };
  }
  const info = await testConnection({ owner: args.owner, repo: args.repo, token: args.token });
  return { fullName: info.fullName, detail: `${info.private ? "私有" : "公开"} · 默认分支 ${info.defaultBranch}` };
}

function sendGithubError(reply: FastifyReply, e: unknown) {
  if (e instanceof GithubError) {
    const status = e.code === "unauthorized" ? 401 : e.code === "not_found" ? 404 : e.code === "rate_limited" ? 429 : 502;
    return reply.code(status).send({ error: e.code, message: e.message });
  }
  return reply.code(400).send({ error: "invalid_input", message: (e as Error).message });
}

export async function adminGithubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/github/repos", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    return { repos: await listGithubReposPublic() };
  });

  app.post("/api/admin/github/repos", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const input = checkRepoRef(parsed.data, reply);
    if (!input) return;
    try {
      const created = await addGithubRepo(input, user.id);
      reply.code(201);
      return { repo: created };
    } catch (e) {
      return reply.code(400).send({ error: "invalid_input", message: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/github/repos/:id", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    try {
      await removeGithubRepo(req.params.id, user.id);
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: "not_found", message: (e as Error).message });
    }
  });

  // 列出该仓库远端的全部分支(后台「选择分支」面板用;按存储的认证方式取)。
  app.get<{ Params: { id: string } }>("/api/admin/github/repos/:id/branches", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const repo = await getGithubRepoById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "not_found", message: "仓库不存在" });
    try {
      const branches = repo.auth === "ssh"
        ? await listBranchesSsh({ owner: repo.owner, repo: repo.repo })
        : (await listBranches({ owner: repo.owner, repo: repo.repo, token: repo.token }, fetch)).branches;
      return { branches, selected: repo.branches ?? [] };
    } catch (e) {
      return sendGithubError(reply, e);
    }
  });

  // 更新该仓库的「周报统计分支」。空数组 = 恢复全部分支。
  app.patch<{ Params: { id: string } }>("/api/admin/github/repos/:id", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const parsed = z.object({ branches: z.array(z.string().min(1).max(200)).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    try {
      const repo = await updateGithubRepoBranches(req.params.id, parsed.data.branches, user.id);
      return { repo };
    } catch (e) {
      return reply.code(404).send({ error: "not_found", message: (e as Error).message });
    }
  });

  // 测试已存仓库(用存储的 token,前端无需重新输入)。
  app.post<{ Params: { id: string } }>("/api/admin/github/repos/:id/test", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const repo = await getGithubRepoById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "not_found", message: "仓库不存在" });
    try {
      const info = await runTest({ owner: repo.owner, repo: repo.repo, auth: repo.auth, token: repo.token });
      return { ok: true, ...info };
    } catch (e) {
      return sendGithubError(reply, e);
    }
  });

  // 临时测试(新增表单提交前验证能否连上;ssh 用本机密钥、token 现填现测)。
  app.post("/api/admin/github/test", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "参数错误" });
    const input = checkRepoRef(parsed.data, reply);
    if (!input) return;
    try {
      const info = await runTest(input);
      return { ok: true, ...info };
    } catch (e) {
      return sendGithubError(reply, e);
    }
  });
}
