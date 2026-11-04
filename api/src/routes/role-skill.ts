// Per-role skill.md REST. Read-only to the client (copy / download); the file
// is AI-generated and refreshed out-of-band by the role-skill dispatcher.
// Access is scoped to the role's members (UserRole) + admins.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RoleSkillSummaryResponse } from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { requireUser, trackBestEffort } from "../utils/guards.js";
import { getUserRoleIds } from "../utils/permissions.js";
import { hasRetrievableContent, RETRIEVABLE_MIN_CHARS } from "../utils/retrievable.js";
import { kickRoleSkill, QUIET_MS } from "../services/role-skill/dispatcher.js";
import { currentRoleSourceHash } from "../services/role-skill/generate.js";
import { slugify } from "../services/role-skill/frontmatter.js";

/** Resolve the role IF the caller may access it (admin or member); otherwise
 *  reply 404 (don't leak existence) and return null. */
async function resolveAccessibleRole(
  reply: FastifyReply,
  roleId: string,
  user: { id: string; isAdmin: boolean },
): Promise<{ id: string; name: string } | null> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
  if (!role) {
    reply.code(404).send({ error: "not_found", message: "角色不存在" });
    return null;
  }
  if (!user.isAdmin) {
    const ids = await getUserRoleIds(user.id);
    if (!ids.has(roleId)) {
      reply.code(404).send({ error: "not_found", message: "角色不存在" });
      return null;
    }
  }
  return role;
}

// 正文超过此长度时只读前缀判定,避免为数个数把全部正文读进内存。
const HEAD_CHARS = 1000;

/**
 * 角色下「有可检索正文」的文档数,口径同 hasRetrievableContent,但不全量取正文:
 * SQL 先按 length(trim(正文)) >= 阈值粗筛(可见字符数必不超过原文长度),
 * 再只取前 HEAD_CHARS 个字符做精确判定;
 *  - 正文不超过前缀 -> 结果与原判定完全一致;
 *  - 更长且前缀通过 -> 计入(极端情况:前缀结尾恰截断在代码块 / 链接中间,可能多计);
 *  - 更长但前缀被剥光 -> 仅这一篇回读全文再判。
 */
async function countRetrievableDocs(roleId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ id: string; len: bigint | number; head: string }>>`
    SELECT "id", length("contentMarkdown") AS len, substr("contentMarkdown", 1, ${HEAD_CHARS}) AS head
    FROM "Article"
    WHERE "roleId" = ${roleId} AND "deletedAt" IS NULL
      AND length(trim("contentMarkdown")) >= ${RETRIEVABLE_MIN_CHARS}`;
  let count = 0;
  for (const r of rows) {
    if (hasRetrievableContent(r.head)) { count++; continue; }
    if (Number(r.len) <= HEAD_CHARS) continue;
    const full = await prisma.article.findUnique({ where: { id: r.id }, select: { contentMarkdown: true } });
    if (full && hasRetrievableContent(full.contentMarkdown)) count++;
  }
  return count;
}

export async function roleSkillRoutes(app: FastifyInstance): Promise<void> {
  // Skill availability per role — drives the chat @ Skills picker. Lists the
  // caller's roles (admins: all) with each role's status + whether it's usable
  // (has generated content → selectable). No skill content in the payload.
  // Static path, so it won't be captured by the parametric /:roleId/skill route.
  app.get("/api/roles/skill-summary", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const where = user.isAdmin ? {} : { id: { in: [...(await getUserRoleIds(user.id))] } };
    const roles = await prisma.role.findMany({
      where,
      select: { id: true, name: true, roleSkill: { select: { status: true, content: true } } },
      orderBy: { name: "asc" },
    });
    const skills = roles.map((r) => ({
      roleId: r.id,
      roleName: r.name,
      status: r.roleSkill?.status ?? "empty",
      // Usable = a generation actually produced content (covers fresh/stale and
      // a failed-after-success row); empty / first-time-generating / first-fail
      // have no content and stay greyed-out + unselectable in the picker.
      usable: !!r.roleSkill && r.roleSkill.content.trim().length > 0,
    }));
    return { skills } satisfies RoleSkillSummaryResponse;
  });

  // Current skill + status for a role.
  app.get<{ Params: { roleId: string } }>("/api/roles/:roleId/skill", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const role = await resolveAccessibleRole(reply, req.params.roleId, user);
    if (!role) return;

    // LIVE count of the role's docs with retrievable content (independent of the
    // last generation's docCount). Drives the UI's "no documents → can't
    // generate" state: 0 means only folders / empty docs / nothing.
    const currentDocCount = await countRetrievableDocs(role.id);

    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    if (!rs) {
      return {
        status: "empty", content: "", name: "", description: "",
        generatedAt: null, stale: true, docCount: 0, currentDocCount, truncated: 0, error: null,
      };
    }
    return {
      status: rs.status,
      content: rs.content,
      name: rs.name,
      description: rs.description,
      generatedAt: rs.generatedAt ? rs.generatedAt.toISOString() : null,
      stale: rs.status !== "fresh",
      docCount: rs.docCount,
      currentDocCount,
      truncated: rs.truncated,
      error: rs.error,
    };
  });

  // Force a regeneration (explicit user action — bypasses the debounce by
  // backdating staleSince, and resets the failure attempt counter).
  app.post<{ Params: { roleId: string } }>("/api/roles/:roleId/skill/regenerate", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const role = await resolveAccessibleRole(reply, req.params.roleId, user);
    if (!role) return;

    // No-op when the skill is already fresh AND the sources are unchanged: don't
    // burn a generation — keep the existing latest and tell the client it's up to date.
    const existing = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    const hash = await currentRoleSourceHash(role.id);
    if (existing && existing.status === "fresh" && existing.content && hash !== null && existing.sourceHash === hash) {
      return { ok: true, status: "fresh", upToDate: true };
    }

    // Otherwise schedule a regeneration. sourceHash is left intact: if the docs
    // really changed the hash differs and generate.ts regenerates; if they didn't
    // (e.g. a failed/stale row) generate's no-op guard reuses the existing content.
    const past = new Date(Date.now() - QUIET_MS - 1000);
    await prisma.roleSkill.upsert({
      where: { roleId: role.id },
      create: { roleId: role.id, status: "stale", staleSince: past, attempts: 0 },
      update: { status: "stale", staleSince: past, attempts: 0 },
    });
    trackBestEffort(kickRoleSkill());
    return { ok: true, status: "stale" };
  });

  // Raw markdown for copy / download.
  app.get<{ Params: { roleId: string }; Querystring: { download?: string } }>(
    "/api/roles/:roleId/skill/raw",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const role = await resolveAccessibleRole(reply, req.params.roleId, user);
      if (!role) return;

      const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
      reply.header("Content-Type", "text/markdown; charset=utf-8");
      if (req.query.download === "1") {
        // Suffix with a short role-id so two roles can't collide on one filename
        // (slugify maps all-CJK names to "" → the same base).
        const fname = `${slugify(role.name) || "role"}-${role.id.slice(0, 6)}-skill.md`;
        reply.header("Content-Disposition", `attachment; filename="${fname}"`);
      }
      return reply.send(rs?.content ?? "");
    },
  );
}
