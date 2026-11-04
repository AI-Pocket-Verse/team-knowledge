import { prisma } from "../../db.js";
import { getSummaryProvider } from "../llm/summary-provider.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import { L, appLang, type Lang } from "../../utils/lang.js";
import { outputLanguageInstruction } from "../llm/language.js";

// Rolling-summary refresh policy:
//   - We refresh when at least `REFRESH_THRESHOLD` brand-new messages
//     have landed since the last summary's anchor. 5 keeps the LLM
//     bandwidth low (one extra call per ~5 turns) while still keeping
//     the summary close enough to the actual conversation that the
//     prompt doesn't go stale.
//   - We cap the produced summary at `MAX_SUMMARY_CHARS` so a chatty
//     model can't blow the prompt budget. Cheap defense — the system
//     prompt asks for ≤150 chars but models drift.
const REFRESH_THRESHOLD = 5;
const MAX_SUMMARY_CHARS = 800;

// Per-message body cap when assembling the transcript fed to the
// summarizer. Long pasted code blocks don't help summary quality and
// inflate tokens — first ~1500 chars are plenty.
const TRANSCRIPT_MSG_CAP = 1500;

// Safety cap for "since anchor" message count. Normally the anchor is
// recent (refresh runs every 5 messages) and `since` is small. But if
// the anchor was deleted by trimConversation, cutoff becomes null and
// we'd otherwise pull every message in the conversation — possibly
// 200 × 1500 chars = 300KB into the LLM. Cap at 30 most-recent
// messages: bounded, still long enough to seed a fresh summary.
const MAX_SINCE_MESSAGES = 30;

// Throttle: even if 5 new messages accumulate, don't fire a refresh
// faster than once per `MIN_REFRESH_INTERVAL_MS`. Protects against
// burst conversations from triggering a flurry of LLM calls.
const MIN_REFRESH_INTERVAL_MS = 30_000;

const SUMMARY_SYSTEM_PROMPT = `你是对话总结助手。任务:基于"此前摘要"和"新增对话",输出一份合并后的新摘要。

要求:
- 中文,150 字以内,不要分点、不要 markdown,一段话即可
- 抽取用户提到的需求/问题/约束、AI 给出的关键结论、仍未解决的方向
- 用第三人称叙述(如"用户希望…","AI 建议…")
- 直接输出新摘要本体,不要任何前缀、引号、解释`;

// In-flight promise lock (per conversation). Two concurrent send
// handlers won't fire two LLM summary calls — the second await's the
// first's result. last-write-wins still holds for the DB update; this
// just deduplicates the expensive LLM hop.
const inflight = new Map<string, Promise<void>>();

// Last successful refresh wallclock (per conversation). Skip if we
// just summarized — burst conversations don't need a summary after
// every single turn.
const lastRefreshAt = new Map<string, number>();

interface MaybeRefreshOpts {
  /** Optional fastify logger forwarded for one-line success/error logging. */
  log?: { error: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

// Refresh the conversation's rolling summary if at least
// REFRESH_THRESHOLD new messages have piled up since the last anchor.
// Returns silently in all failure cases — this runs as a fire-and-
// forget background task after each assistant turn, must not throw.
export async function maybeRefreshSummary(
  conversationId: string,
  opts: MaybeRefreshOpts = {},
): Promise<void> {
  // Throttle: bail if we summarized recently.
  const last = lastRefreshAt.get(conversationId);
  if (last !== undefined && Date.now() - last < MIN_REFRESH_INTERVAL_MS) return;

  // Concurrency lock: dedupe parallel calls per conversation.
  const existing = inflight.get(conversationId);
  if (existing) return existing;

  const p = doRefresh(conversationId, opts).finally(() => {
    inflight.delete(conversationId);
  });
  inflight.set(conversationId, p);
  return p;
}

async function doRefresh(conversationId: string, opts: MaybeRefreshOpts): Promise<void> {
  const startedAt = Date.now();
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return;

    // Resolve the anchor's createdAt (if any). If the anchor row was
    // trimmed away in the meantime, fall back to cutoff=null and re-
    // summarize whatever survives (capped by MAX_SINCE_MESSAGES below
    // so we don't dump the whole conversation into one LLM call).
    let cutoff: Date | null = null;
    if (conv.summaryUpToMessageId) {
      const anchor = await prisma.chatMessage.findUnique({
        where: { id: conv.summaryUpToMessageId },
        select: { createdAt: true },
      });
      if (anchor) cutoff = anchor.createdAt;
    }

    // (B2 fix) Use `gte cutoff` + `NOT { id: anchorId }` instead of
    // `gt cutoff`. Two messages can share the same millisecond
    // (SQLite's DateTime resolution + fast LLM round-trips); a strict
    // `gt` would drop the user message inserted at exactly the
    // anchor's ms, leaving it permanently uncaptured.
    const sinceWhere = cutoff && conv.summaryUpToMessageId
      ? { conversationId, createdAt: { gte: cutoff }, NOT: { id: conv.summaryUpToMessageId } }
      : { conversationId };

    // (N2 fix) Cap take + take from the back so the runaway case
    // (deleted anchor) doesn't dump 200 messages into one LLM call.
    const recent = await prisma.chatMessage.findMany({
      where: sinceWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_SINCE_MESSAGES,
    });
    const since = recent.reverse(); // chronological for the transcript

    if (since.length < REFRESH_THRESHOLD) return;

    // (O2) Resolve cited-doc titles for the transcript so the summary
    // keeps semantic info like "user asked about doc X". Without this
    // the summary only sees raw message text and loses the structured
    // grounding the chat turn had.
    const allCitedIds = Array.from(new Set(
      since.flatMap((m) => {
        if (!m.citedArticleIds) return [];
        try {
          const v: unknown = JSON.parse(m.citedArticleIds);
          return Array.isArray(v) ? (v as string[]) : [];
        } catch { return []; }
      }),
    ));
    const titleById = new Map<string, string>();
    if (allCitedIds.length > 0) {
      const articles = await prisma.article.findMany({
        where: { id: { in: allCitedIds } },
        select: { id: true, title: true },
      });
      for (const a of articles) titleById.set(a.id, a.title);
    }

    const transcript = since
      .map((m) => {
        const speaker = m.role === "user" ? "用户" : "AI";
        // 生图轮 content 为空、叙述存 thinking → 用 content || thinking,否则摘要看到空 AI 行、丢这轮。
        const body = (m.content || m.thinking || "").slice(0, TRANSCRIPT_MSG_CAP);
        // Annotate assistant turns with their cited docs so the
        // summarizer knows "AI cited doc X, Y" — improves long-term
        // narrative quality without inflating the transcript much.
        let citedNote = "";
        if (m.role === "assistant" && m.citedArticleIds) {
          try {
            const ids = JSON.parse(m.citedArticleIds) as unknown;
            if (Array.isArray(ids) && ids.length > 0) {
              const titles = (ids as string[])
                .map((id) => titleById.get(id))
                .filter((t): t is string => !!t)
                .map((t) => `《${t}》`);
              if (titles.length > 0) citedNote = `\n[本轮引用:${titles.join("、")}]`;
            }
          } catch { /* ignore malformed */ }
        }
        return `${speaker}: ${body}${citedNote}`;
      })
      .join("\n\n");

    const oldSummary = conv.summary && conv.summary.trim().length > 0 ? conv.summary : "无";
    const userMessage = `[此前摘要]\n${oldSummary}\n\n[新增对话]\n${transcript}`;

    // (B3 fix) Acquire the same semaphore that user chat turns use,
    // so a flurry of summary refreshes can't blow past the provider's
    // concurrency limit. Short timeout (5s) — if we can't get a slot
    // promptly, skip this refresh and let the next turn retry.
    let release: (() => void) | null = null;
    try {
      release = await chatSemaphore.acquire(5_000);
    } catch {
      opts.log?.error?.({ event: "summary.refresh.semaphore_busy", conversationId }, "summary refresh skipped (semaphore busy)");
      return;
    }

    const provider = await getSummaryProvider();
    const ac = new AbortController();
    // Self-imposed safety: bound the summary call so it never camps
    // a semaphore slot for longer than 60s. Real summaries finish in
    // single-digit seconds.
    const guard = setTimeout(() => ac.abort(), 60_000);

    let next = "";
    let llmFailed = false;
    try {
      for await (const chunk of provider.chat({
        systemPrompt: SUMMARY_SYSTEM_PROMPT + outputLanguageInstruction(appLang()),
        history: [],
        userMessage,
      }, ac.signal)) {
        if (chunk.type === "token") next += chunk.text;
        else if (chunk.type === "error") {
          opts.log?.error?.({ event: "summary.refresh.llm_error", conversationId, message: chunk.message }, "summary refresh failed");
          llmFailed = true;
          break;
        }
      }
    } finally {
      clearTimeout(guard);
      release();
    }

    next = next.trim().slice(0, MAX_SUMMARY_CHARS);
    // (O7) Fallback: if the LLM failed or returned empty, fall back
    // to an extractive summary (first sentence per message). Better
    // than null — preserves at least the conversation skeleton so
    // older context isn't completely lost.
    if (!next) {
      // 生图轮 content 为空、叙述存 thinking → 折叠成 content,否则抽取式摘要会整轮丢弃。
      next = extractiveFallback(since.map((m) => ({ role: m.role, content: m.content || m.thinking || "" }))).slice(0, MAX_SUMMARY_CHARS);
      if (next) {
        opts.log?.info?.(
          { event: "summary.refresh.extractive_fallback", conversationId, sinceCount: since.length, summaryChars: next.length, llmFailed },
          "summary refresh used extractive fallback",
        );
      }
    }
    if (!next) return;

    const anchorRow = since[since.length - 1];
    if (!anchorRow) return;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        summary: next,
        summaryUpToMessageId: anchorRow.id,
        summaryUpdatedAt: new Date(),
      },
    });

    lastRefreshAt.set(conversationId, Date.now());
    // (N4) Success telemetry: lets us see refresh cadence + cost in logs.
    opts.log?.info?.(
      {
        event: "summary.refresh.ok",
        conversationId,
        sinceCount: since.length,
        summaryChars: next.length,
        durationMs: Date.now() - startedAt,
      },
      "summary refresh ok",
    );
  } catch (e) {
    opts.log?.error?.({ event: "summary.refresh.exception", conversationId, err: (e as Error).message }, "summary refresh exception");
  }
}

// (O7) Last-resort summary when the LLM is unavailable: take the
// first ~80-char sentence from each of the last 10 messages and join
// with "; ". Loses nuance but at least preserves the conversational
// arc so the next chat turn sees SOMETHING in [此前对话摘要]. The
// caller is expected to slice the result to MAX_SUMMARY_CHARS.
function extractiveFallback(messages: { role: string; content: string }[]): string {
  return messages
    .slice(-10)
    .map((m) => {
      // Split on Chinese sentence terminators + western punctuation.
      // Drop empty pieces, take the first non-empty one as the
      // representative sentence.
      const first = (m.content.split(/[。.!?\n]/).find((s) => s.trim().length > 0) ?? "").trim().slice(0, 80);
      if (!first) return null;
      const speaker = m.role === "user" ? "用户" : "AI";
      return `${speaker}:${first}`;
    })
    .filter((s): s is string => s !== null)
    .join("; ");
}

// Test-only export so tests can reset the module-level dedup maps
// between cases without forcing a module reload.
export function _resetSummarizerCachesForTests(): void {
  inflight.clear();
  lastRefreshAt.clear();
}
