import { prisma } from "../../db.js";
import { hasRetrievableContent } from "../../utils/retrievable.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import type { ChatPrompt } from "../llm/types.js";
import { computeSourceHash, packArticles, buildDocIndex } from "./source.js";
import { SKILL_SYSTEM_PROMPT, buildSkillUserMessage } from "./prompt.js";
import { ensureFrontmatter, slugify } from "./frontmatter.js";
import { notifySkillUpdated } from "./notify.js";
import { resolveModelDisplay } from "../llm/model-display.js";
import { L, appLang } from "../../utils/lang.js";
import { outputLanguageInstruction } from "../llm/language.js";

interface GenLog {
  error?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  info?: (...a: unknown[]) => void;
}

/**
 * The sourceHash a fresh generation WOULD produce right now for `roleId` — i.e.
 * the signature of the role's current name/description + published docs. Returns
 * null if the role no longer exists. Used by the regenerate route to short-circuit
 * a no-op when the stored skill already matches the current sources.
 */
export async function currentRoleSourceHash(roleId: string): Promise<string | null> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true, description: true } });
  if (!role) return null;
  const rows = await prisma.article.findMany({
    where: { roleId, deletedAt: null },
    select: { id: true, title: true, updatedAt: true, contentMarkdown: true },
  });
  // 去状态后:按正文长度纳入技能源(空/过短文档不计入)。
  const articles = rows
    .filter((a) => hasRetrievableContent(a.contentMarkdown))
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  return computeSourceHash({ name: role.name, description: role.description, articles });
}

// Generous: a CLI provider distilling many docs can legitimately take a while;
// a too-tight bound spuriously aborts (→ failed). Still bounded so a hung CLI
// can't camp a semaphore slot forever. Must stay < the dispatcher's GEN_STUCK_MS.
const GEN_TIMEOUT_MS = 180_000;

/** Thrown when the shared chat semaphore is saturated — contention with live
 *  chat/meetings, NOT a real failure, so it must not consume a retry attempt. */
class ProviderBusyError extends Error {}

/** One-shot completion via the current provider (Claude/Codex CLI). Consumes
 *  the streamed chunks into a single string; throws on provider error / empty. */
async function runProvider(prompt: ChatPrompt): Promise<{ text: string; providerName: string }> {
  const provider = await getProvider();
  let release: (() => void) | null = null;
  try {
    release = await chatSemaphore.acquire(5_000);
  } catch {
    throw new ProviderBusyError("provider busy (semaphore timeout)");
  }
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), GEN_TIMEOUT_MS);
  let text = "";
  try {
    for await (const chunk of provider.chat(prompt, ac.signal)) {
      if (chunk.type === "token") text += chunk.text;
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
  } finally {
    clearTimeout(guard);
    release();
  }
  text = text.trim();
  if (!text) throw new Error("empty generation");
  return { text, providerName: provider.name };
}

/**
 * Generate (or refresh) a role's skill.md from its PUBLISHED docs and persist
 * it to RoleSkill. Idempotent + cheap when nothing changed:
 *  - skips if another pass already holds `generating`
 *  - skips the model call when sourceHash is unchanged (just clears `stale`)
 *  - 收录文档 0 篇 → 跳过:不生成、不通知,标记终止态 "empty"
 * On failure: status=failed, error recorded, attempts incremented (dispatcher
 * retries up to its cap).
 */
export async function generateRoleSkill(roleId: string, opts: { log?: GenLog } = {}): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) return; // role deleted — RoleSkill cascades away

  const rows = await prisma.article.findMany({
    where: { roleId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, contentMarkdown: true, updatedAt: true },
  });
  // 去状态后:按正文长度纳入技能源(空/过短文档不计入)。
  const articles = rows.filter((a) => hasRetrievableContent(a.contentMarkdown));

  const sourceHash = computeSourceHash({ name: role.name, description: role.description, articles });

  const existing = await prisma.roleSkill.findUnique({ where: { roleId } });
  if (existing?.status === "generating") return; // another pass in flight

  // 收录文档 0 篇:不生成、也不发群通知。标记终止态 "empty" —— sweep 只挑
  // stale|failed,故不会再反复重试;日后发布文档会经 markRoleSkillStale 重新
  // 触发生成。(此前会写一篇占位 stub 并发通知,现按需求去掉。)
  if (articles.length === 0) {
    await prisma.roleSkill.upsert({
      where: { roleId },
      create: { roleId, status: "empty", sourceHash, docCount: 0 },
      update: { status: "empty", sourceHash, docCount: 0, staleSince: null, attempts: 0, error: null },
    });
    opts.log?.info?.({ event: "role-skill.generate.skip-empty", roleId }, "role skill skipped: no published docs");
    return;
  }

  // No-op guard: inputs unchanged since the last successful generation.
  if (existing && existing.content && existing.status !== "failed" && existing.sourceHash === sourceHash) {
    if (existing.status !== "fresh") {
      await prisma.roleSkill.update({ where: { roleId }, data: { status: "fresh", staleSince: null } });
    }
    return;
  }

  try {
    // Claim the row (inside try so an FK error — role deleted in this window —
    // is caught rather than escaping as an unhandled rejection).
    await prisma.roleSkill.upsert({
      where: { roleId },
      create: { roleId, status: "generating" },
      update: { status: "generating" },
    });

    const fallbackName = slugify(role.name) || `role-${roleId.slice(0, 8)}`;
    const fallbackDesc = role.description?.trim() || L(appLang(), `${role.name} 知识技能`, `${role.name} knowledge skill`);

    // articles.length === 0 已在函数前部提前返回,这里必有已发布文档。
    const packed = packArticles(articles.map((a) => ({ title: a.title, contentMarkdown: a.contentMarkdown })));
    const docCount = packed.docCount;
    const truncated = packed.truncated;
    const userMessage = buildSkillUserMessage({
      roleName: role.name,
      roleDescription: role.description,
      packedBody: packed.body,
      docIndex: buildDocIndex(articles),
      docCount,
      truncated,
    });
    const { text: rawContent, providerName: model } = await runProvider({ systemPrompt: SKILL_SYSTEM_PROMPT + outputLanguageInstruction(appLang()), history: [], userMessage });

    const fm = ensureFrontmatter(rawContent, { name: fallbackName, description: fallbackDesc });

    // Only commit if we still hold the "generating" claim. If a change landed
    // mid-generation, markRoleSkillStale flipped status back to "stale" — this
    // write then affects 0 rows, the stale mark survives, and the next sweep
    // regenerates with the latest docs (rather than overwriting it as fresh).
    // 通知用「本次相对上次」对比的是 skill.md 这份产物本身(上一版 vs 本次),
    // 不读源文档。上一版 = 覆盖前的 existing.content(空 = 首次生成)。
    const prevContent = existing?.content ?? null;

    const generatedAt = new Date();
    const committed = await prisma.roleSkill.updateMany({
      where: { roleId, status: "generating" },
      data: {
        content: fm.content,
        name: fm.name,
        description: fm.description,
        status: "fresh",
        sourceHash,
        docCount,
        truncated,
        model,
        generatedAt,
        attempts: 0,
        error: null,
      },
    });
    opts.log?.info?.({ event: "role-skill.generate.ok", roleId, docCount, truncated, model }, "role skill generated");
    // 飞书群通知只在本次提交真正生效时发(claim 被 mid-flight stale 抢走 →
    // 0 行,等下一轮 sweep 重新生成时再通知);fire-and-forget,不影响生成。
    if (committed.count > 0) {
      // notifySkillUpdated 内部已整体 try/catch;这里再兜一层 —— 它一旦抛出
      // (未来改动疏漏),fire-and-forget 的 rejection 会直接崩进程。
      notifySkillUpdated({ roleId, roleName: role.name, docCount, model: await resolveModelDisplay(model), generatedAt, prevContent, newContent: fm.content, log: opts.log })
        .catch((e) => opts.log?.warn?.({ event: "role-skill.notify.threw", roleId, err: (e as Error).message }, "skill update notify threw"));
    }
  } catch (e) {
    if (e instanceof ProviderBusyError) {
      // Lost to live traffic — defer, don't fail. Drop back to stale (keeping the
      // original staleSince so it's still due) WITHOUT charging an attempt, so the
      // next sweep simply retries once capacity frees. Guarded on `generating` so
      // a stale mark that arrived mid-flight still wins.
      opts.log?.info?.({ event: "role-skill.generate.busy", roleId }, "role skill regen deferred (provider busy)");
      await prisma.roleSkill
        .updateMany({ where: { roleId, status: "generating" }, data: { status: "stale" } })
        .catch(() => undefined);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    opts.log?.error?.({ event: "role-skill.generate.fail", roleId, err: message }, "role skill generation failed");
    // Same claim guard as the success path: a stale mark that arrived mid-flight
    // takes precedence over recording this attempt as failed.
    await prisma.roleSkill
      .updateMany({ where: { roleId, status: "generating" }, data: { status: "failed", error: message.slice(0, 500), attempts: { increment: 1 } } })
      .catch(() => undefined);
  }
}
