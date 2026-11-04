// Transport-agnostic chat turn orchestration. Extracted from routes/chat.ts so
// BOTH the web SSE route and the Feishu 1:1 path share one chat core (retrieval
// → prompt → provider → persist → rolling-summary). Callers adapt `onChunk` to
// their transport (web → SSE-to-browser; feishu → SSE-to-feishu-sso-bridge).
import type { FastifyBaseLogger } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { type SearchHit } from "../retrieval/fts5.js";
import { prepareGeneralPrompt } from "./prompt-core.js";
import { getProvider } from "../llm/registry.js";
import type { ChatChunk } from "../llm/types.js";
import { chatSemaphore, runExclusive } from "../../utils/concurrency.js";
import {
  getArticlePermissions, getUserRoleIds, isArticleCollaborator,
  getCollaboratorArticleIds, getEffectiveFolderPermissions,
} from "../../utils/permissions.js";
import { hasRetrievableContent } from "../../utils/retrievable.js";
import { maybeRefreshSummary } from "./summarize.js";
import { publishChatUpdate, publishChatEvent } from "./chat-events.js";
import { mirrorWebTurnToFeishu } from "./feishu-mirror.js";
import { resolveChatImages } from "../uploads/image-store.js";
import { extractSnippet } from "../retrieval/snippet.js";
import { touchConversation } from "./conversations.js";

// Mirror the BODY_CAP in fts5.ts (20K chars). Centralizing the constant
// across modules would create an import cycle for one number; the value
// is stable enough that drift isn't a real risk. Used to bound the
// contentMarkdown we pull for mention-resolved docs at the DB level.
const BODY_CAP = 20_000;

/** Thrown when the global chat semaphore can't be acquired within the timeout.
 *  The web route maps this to a pre-stream HTTP 429 (no SSE opened yet). */
export class ChatBusyError extends Error {
  constructor() {
    super("AI 当前繁忙，请稍后再试");
    this.name = "ChatBusyError";
  }
}

// When the chat request carries an `articleId` (the user is reading
// that article and wants the panel scoped to it), load that article
// as a fully-formed SearchHit so it can be PREPENDED to the FTS
// retrieved list. Returns null if the article doesn't exist or the
// caller can't view it — we silently fall back to FTS-only so the
// chat doesn't error on a missing article.
export async function loadActiveArticle(
  articleId: string,
  user: { id: string; isAdmin: boolean },
  userRoleIds: Set<string>,
): Promise<SearchHit | null> {
  const a = await prisma.article.findUnique({
    where: { id: articleId },
    include: { folder: { include: { role: true } }, role: true },
  });
  if (!a || a.deletedAt != null) return null;
  const mp = getEffectiveFolderPermissions({
    user,
    userRoleIds,
    article: { roleId: a.roleId, folder: a.folder },
  });
  // Allow a collaborator on a private-folder article to anchor chat
  // on that article ("总结这篇文档") even when their role doesn't
  // grant folder view.
  const isCollaborator = await isArticleCollaborator(user.id, a.id);
  const perms = getArticlePermissions({
    folderPermissions: mp,
    article: { createdById: a.createdById },
    userId: user.id, isAdmin: user.isAdmin,
    isCollaborator,
  });
  if (!perms.canView) return null;
  const body = a.contentMarkdown.slice(0, 20_000);
  return {
    articleId: a.id,
    title: a.title,
    snippet: "",
    body,
    folderId: a.folderId ?? "",
    roleId: a.roleId,
    folderName: a.folder?.name ?? a.role.name,
    roleName: a.role.name,
  };
}

export function decodeCited(s: string | null): string[] {
  if (!s) return [];
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? (v as string[]) : []; } catch { return []; }
}

// Inverse of the JSON.stringify on persist. Snapshots saved by the turn are
// `[{ type, id, label }]`; a row written by an older client without this column
// or with a malformed payload quietly drops back to an empty list.
export interface PersistedMention { type: "doc" | "folder" | "role" | "skill"; id: string; label: string }
export function decodeMentions(s: string | null): PersistedMention[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v
      .filter((m): m is PersistedMention =>
        m !== null &&
        typeof m === "object" &&
        (m as { type?: unknown }).type !== undefined &&
        ["doc", "folder", "role", "skill"].includes((m as { type: string }).type) &&
        typeof (m as { id?: unknown }).id === "string" &&
        typeof (m as { label?: unknown }).label === "string",
      )
      .slice(0, 10);
  } catch { return []; }
}

// Resolve incoming {type,id} mentions into the SearchHit list to PREPEND to
// retrieval, plus the snapshot `[{type,id,label}]` to persist. Each branch
// enforces permission filtering — a malicious client can't smuggle a private
// folder's docs in via the mention payload (re-checks getEffectiveFolderPermissions).
export async function resolveMentions(
  raw: { type: "doc" | "folder" | "role" | "skill"; id: string }[],
  user: { id: string; isAdmin: boolean },
  userRoleIds: Set<string>,
  userMessage: string,
): Promise<{ hits: SearchHit[]; snapshot: PersistedMention[]; skillBlocks: { label: string; content: string }[] }> {
  const hits: SearchHit[] = [];
  const snapshot: PersistedMention[] = [];
  const skillBlocks: { label: string; content: string }[] = [];
  if (raw.length === 0) return { hits, snapshot, skillBlocks };

  const docIds   = Array.from(new Set(raw.filter((m) => m.type === "doc").map((m) => m.id)));
  const folderIds = Array.from(new Set(raw.filter((m) => m.type === "folder").map((m) => m.id)));
  const roleIds  = Array.from(new Set(raw.filter((m) => m.type === "role").map((m) => m.id)));
  const skillIds = Array.from(new Set(raw.filter((m) => m.type === "skill").map((m) => m.id)));

  if (docIds.length > 0) {
    const [docs, bodyRows] = await Promise.all([
      prisma.article.findMany({
        where: { id: { in: docIds }, deletedAt: null },
        select: {
          id: true, title: true, folderId: true, roleId: true, createdById: true,
          folder: { select: { name: true, roleId: true, visibility: true, role: { select: { name: true } } } },
          role: { select: { name: true } },
        },
      }),
      prisma.$queryRaw<Array<{ id: string; body: string }>>`
        SELECT id, substr(contentMarkdown, 1, ${Prisma.raw(String(BODY_CAP))}) AS body
        FROM Article
        WHERE id IN (${Prisma.join(docIds)}) AND deletedAt IS NULL
      `,
    ]);
    const bodyById = new Map(bodyRows.map((r) => [r.id, r.body]));
    const collabSet = await getCollaboratorArticleIds(user.id, docIds);
    for (const a of docs) {
      const mp = getEffectiveFolderPermissions({
        user, userRoleIds,
        article: { roleId: a.roleId, folder: a.folder },
      });
      const perms = getArticlePermissions({
        folderPermissions: mp,
        article: { createdById: a.createdById },
        userId: user.id, isAdmin: user.isAdmin,
        isCollaborator: collabSet.has(a.id),
      });
      if (!perms.canView) continue;
      hits.push({
        articleId: a.id, title: a.title, snippet: "",
        body: bodyById.get(a.id) ?? "",
        folderId: a.folderId ?? "", roleId: a.roleId,
        folderName: a.folder?.name ?? a.role.name,
        roleName: a.role.name,
      });
      snapshot.push({ type: "doc", id: a.id, label: a.title });
    }
  }

  if (folderIds.length > 0) {
    const folders = await prisma.folder.findMany({
      where: { id: { in: folderIds }, deletedAt: null },
      include: { role: true },
    });
    for (const f of folders) {
      const mp = getEffectiveFolderPermissions({
        user, userRoleIds,
        article: { roleId: f.roleId, folder: { roleId: f.roleId, visibility: f.visibility } },
      });
      if (!mp.canView) continue;
      const articles = (await prisma.article.findMany({
        where: { folderId: f.id, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: { folder: { include: { role: true } }, role: true },
      })).filter((a) => hasRetrievableContent(a.contentMarkdown));
      for (const a of articles) {
        hits.push({
          articleId: a.id, title: a.title, snippet: "",
          body: extractSnippet(a.contentMarkdown.slice(0, 20_000), userMessage),
          folderId: a.folderId ?? "", roleId: a.roleId,
          folderName: a.folder?.name ?? a.role.name,
          roleName: a.role.name,
        });
      }
      snapshot.push({ type: "folder", id: f.id, label: f.name });
    }
  }

  if (roleIds.length > 0) {
    const roles = await prisma.role.findMany({ where: { id: { in: roleIds } } });
    for (const r of roles) {
      if (!userRoleIds.has(r.id) && !user.isAdmin) continue;
      const articles = (await prisma.article.findMany({
        where: { roleId: r.id, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: { folder: { include: { role: true } }, role: true },
      })).filter((a) => hasRetrievableContent(a.contentMarkdown));
      for (const a of articles) {
        const mp = getEffectiveFolderPermissions({
          user, userRoleIds,
          article: { roleId: a.roleId, folder: a.folder },
        });
        if (!mp.canView) continue;
        hits.push({
          articleId: a.id, title: a.title, snippet: "",
          body: extractSnippet(a.contentMarkdown.slice(0, 20_000), userMessage),
          folderId: a.folderId ?? "", roleId: a.roleId,
          folderName: a.folder?.name ?? a.role.name,
          roleName: a.role.name,
        });
      }
      snapshot.push({ type: "role", id: r.id, label: r.name });
    }
  }

  if (skillIds.length > 0) {
    const roles = await prisma.role.findMany({
      where: { id: { in: skillIds } },
      include: { roleSkill: true },
    });
    for (const r of roles) {
      if (!userRoleIds.has(r.id) && !user.isAdmin) continue;
      const articles = (await prisma.article.findMany({
        where: { roleId: r.id, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: { folder: { include: { role: true } }, role: true },
      })).filter((a) => hasRetrievableContent(a.contentMarkdown));
      for (const a of articles) {
        const mp = getEffectiveFolderPermissions({
          user, userRoleIds,
          article: { roleId: a.roleId, folder: a.folder },
        });
        if (!mp.canView) continue;
        hits.push({
          articleId: a.id, title: a.title, snippet: "",
          body: extractSnippet(a.contentMarkdown.slice(0, 20_000), userMessage),
          folderId: a.folderId ?? "", roleId: a.roleId,
          folderName: a.folder?.name ?? a.role.name,
          roleName: a.role.name,
        });
      }
      if (r.roleSkill && r.roleSkill.content.trim().length > 0) {
        skillBlocks.push({ label: r.name, content: r.roleSkill.content });
      }
      snapshot.push({ type: "skill", id: r.id, label: `${r.name}Skill` });
    }
  }

  return { hits, snapshot, skillBlocks };
}

// 历史不再裁剪:保留无上限,改由分页 + 上滑懒加载按需取(见 /api/chat/conversation)。
// 保留导出签名,调用方(routes/experts、runChatTurn)无需改动;此处为无操作。
export async function trimConversation(_conversationId: string): Promise<void> {
  /* no-op: retention is unbounded now */
}

// ── Public chat-turn API ───────────────────────────────────────────────────

export type ChatTurnScope = "web" | "feishu"; // group 留二期

// What `onChunk` receives: a `cited` event first (citation refs in [#N] order),
// then the provider's token/thinking/thinking_end/done/error stream.
export type ChatTurnChunk =
  | { type: "cited"; articleIds: string[]; refs: { n: number; articleId: string; title: string; folderId: string | null; roleId: string }[] }
  | ChatChunk;

export interface RunChatTurnArgs {
  user: { id: string; isAdmin: boolean; chatPreference?: string | null };
  /** 本轮所属会话 id。调用方负责解析(web 路由按 body / 飞书走专用会话)并校验归属。 */
  conversationId: string;
  text: string;
  scope: ChatTurnScope;
  articleId?: string;
  mentions?: { type: "doc" | "folder" | "role" | "skill"; id: string }[];
  /** 随消息附带的图片(/uploads/<file> 视图)。须是发送者本人上传的图片
   *  (此处会校验归属);LLM 经各 provider 的视觉通道真实读图。最多 3 张。 */
  images?: string[];
  signal: AbortSignal;
  onChunk: (c: ChatTurnChunk) => void;
  log: FastifyBaseLogger;
}

/**
 * Run one chat turn end-to-end. Acquires the per-conversation lock + global
 * semaphore, persists the user message, retrieves + builds the prompt, streams
 * the provider, persists the assistant message, and fires the rolling-summary
 * refresh. All stream events go through `onChunk`; the ONLY thrown error is
 * ChatBusyError (semaphore timeout, before any chunk) so a caller can map it to
 * a pre-stream HTTP 429. Prep failures and mid-stream errors are delivered as
 * `{ type: "error" }` chunks (matching the web route's prior behavior).
 */
export async function runChatTurn(args: RunChatTurnArgs): Promise<void> {
  const { user, text: content, scope, signal, onChunk, log, conversationId } = args;
  const source = scope; // "web" | "feishu" → ChatMessage.source
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });

  await runExclusive(conv.id, async () => {
    let release: () => void;
    try {
      release = await chatSemaphore.acquire(30_000);
    } catch {
      throw new ChatBusyError();
    }
    // Inner controller forwards the caller's signal (req close) AND lets us
    // abort the spawned LLM child on a prep failure.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      const userRoleIds = await getUserRoleIds(user.id);
      const { hits: mentionHits, snapshot: mentionSnapshot, skillBlocks: mentionSkills } = await resolveMentions(
        args.mentions ?? [], { id: user.id, isAdmin: user.isAdmin }, userRoleIds, content,
      );

      // 图片:校验归属(必须是该用户自己的上传、且确为图片)并取得 LLM 可读的
      // 绝对路径。校验失败按输入错误回给调用方,不落任何消息。
      let chatImages: { urls: string[]; absPaths: string[] };
      try {
        chatImages = await resolveChatImages(user.id, args.images ?? []);
      } catch (e) {
        onChunk({ type: "error", message: (e as Error).message });
        return;
      }

      const justInserted = await prisma.chatMessage.create({
        data: {
          conversationId: conv.id, role: "user", content,
          citedArticleIds: null,
          mentions: mentionSnapshot.length > 0 ? JSON.stringify(mentionSnapshot) : null,
          source,
          images: chatImages.urls.length > 0 ? JSON.stringify(chatImages.urls) : null,
        },
      });
      void touchConversation(conv.id, justInserted.createdAt);
      // 双端实时一致:飞书发起的轮次把完整流式生命周期镜像到该用户打开的网页
      // 聊天(remote_* 事件,网页呈现与本页发送一致的打字机);网页发起的轮次
      // 用 update 提醒其它标签页刷新(发起页自己在流式,hydrate 守卫会跳过)。
      const mirror = source === "feishu";
      if (mirror) publishChatEvent(user.id, "remote_start", { text: content, images: chatImages.urls });
      else publishChatUpdate(user.id, { source });

      const provider = await getProvider();

      // 只发图不发文字时给模型一句兜底指令(持久化的 content 保持原样为空,
      // 网页/飞书只展示图片)。
      const promptText = content.trim() || "(我发了图片,请查看图片内容并回应。)";

      const preparePromise = (async () => {
        const historyCap = conv.summary ? 4 : 8;
        const recent = await prisma.chatMessage.findMany({
          where: { conversationId: conv.id, NOT: { id: justInserted.id } },
          orderBy: { createdAt: "desc" }, take: historyCap,
        });
        const history = recent.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
        const activeArticle = args.articleId
          ? await loadActiveArticle(args.articleId, { id: user.id, isAdmin: user.isAdmin }, userRoleIds)
          : null;
        // 共享问答核心(检索 + @引用合并 + 建 prompt + 摘要压力刷新);与 orchestrate 无专家路径同一份逻辑。
        const prepared = await prepareGeneralPrompt({
          userId: user.id, isAdmin: user.isAdmin, chatPreference: user.chatPreference ?? undefined,
          question: promptText,
          resolvedMentions: { hits: mentionHits, snapshot: mentionSnapshot, skillBlocks: mentionSkills },
          history, summary: conv.summary ?? undefined, activeArticle, conversationId: conv.id,
        });
        return { prepared };
      })();

      const llmIter = provider.chat(
        preparePromise.then((p) => ({ systemPrompt: p.prepared.systemPrompt, history: p.prepared.history, userMessage: p.prepared.userMessage })),
        ac.signal,
        // 图片绝对路径在 spawn 时就要确定(argv/cwd),故走 opts 而非 prompt。
        chatImages.absPaths.length > 0 ? { images: chatImages.absPaths } : undefined,
      );

      let prep: { prepared: Awaited<ReturnType<typeof prepareGeneralPrompt>> };
      try {
        prep = await preparePromise;
      } catch (e) {
        ac.abort();
        onChunk({ type: "error", message: (e as Error).message });
        return;
      }
      const built = prep.prepared;

      const citedRefs = built.includedHits.map((h, i) => ({ n: i + 1, articleId: h.articleId, title: h.title, folderId: h.folderId, roleId: h.roleId }));
      onChunk({ type: "cited", articleIds: built.citedArticleIds, refs: citedRefs });
      if (mirror) publishChatEvent(user.id, "remote_cited", { refs: citedRefs });

      let assistantText = "";
      let persisted = false;
      const persistAssistant = async (suffix: string): Promise<void> => {
        if (persisted) return;
        persisted = true;
        if (assistantText.length === 0) return;
        let body = assistantText;
        if (body.length > 10_000) body = body.slice(0, 10_000) + "…（已截断）";
        if (suffix) body = body + suffix;
        await prisma.chatMessage.create({
          data: {
            conversationId: conv.id, role: "assistant", content: body,
            citedArticleIds: JSON.stringify(built.citedArticleIds), source,
          },
        });
        trimConversation(conv.id).catch((e) => log.error(e, "trimConversation failed"));
        publishChatUpdate(user.id, { source });
        // 反向同步:网页轮次完成后把「问题 + 回答」推一张卡片到用户飞书 1:1
        // 会话(fire-and-forget,失败只记日志,不影响轮次)。
        if (source === "web") void mirrorWebTurnToFeishu({ userId: user.id, question: content, answer: body, images: chatImages.urls, log });
      };

      try {
        for await (const chunk of llmIter) {
          if (chunk.type === "token") {
            assistantText += chunk.text;
            onChunk(chunk);
            if (mirror) publishChatEvent(user.id, "remote_token", { text: chunk.text });
          } else if (chunk.type === "thinking") {
            onChunk(chunk);
            if (mirror) publishChatEvent(user.id, "remote_thinking", { text: chunk.text });
          } else if (chunk.type === "thinking_end") {
            onChunk(chunk);
            if (mirror) publishChatEvent(user.id, "remote_thinking_end", {});
          } else if (chunk.type === "done") {
            await persistAssistant("");
            log.info(
              { event: "chat.turn", userId: user.id, scope, replyLen: assistantText.length, citedCount: built.citedArticleIds.length },
              "chat turn completed",
            );
            void maybeRefreshSummary(conv.id, { log });
            onChunk({ type: "done" });
            if (mirror) publishChatEvent(user.id, "remote_done", {});
          } else if (chunk.type === "error") {
            await persistAssistant("\n\n（AI 中断，以下为部分输出）").catch((e) => log.error(e, "persist partial failed"));
            onChunk(chunk);
            if (mirror) publishChatEvent(user.id, "remote_error", {});
          }
        }
      } catch (e) {
        await persistAssistant("\n\n（AI 中断）").catch((logErr) => log.error(logErr, "persist partial failed"));
        onChunk({ type: "error", message: (e as Error).message });
        if (mirror) publishChatEvent(user.id, "remote_error", {});
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      release();
    }
  });
}
