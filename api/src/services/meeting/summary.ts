import type { FastifyBaseLogger } from "fastify";
import { MEETING_SUMMARY_FAILED_PREFIX } from "@team-knowledge/shared";
import { prisma } from "../../db.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import { notifyMeetingMinutes, claimMinutesNotified } from "./notify.js";
import { emitSelfNotification } from "../../utils/notify/self.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

// ─── Meeting summary generator ────────────────────────────
// Pulls a finalized meeting's transcripts + assistant comments out
// of the DB, hands them to the existing LLM provider, and writes
// the markdown summary back to MeetingSession.summaryMarkdown.
//
// Idempotency: if `summaryMarkdown` is already set, the helper
// is a no-op (returns the existing markdown). The REST DELETE
// path fires this as fire-and-forget after marking the session
// ended; a separate POST /api/meeting/:id/summary route lets
// an admin re-trigger on failure.
//
// Defensive: every step (fetch, LLM, persist) is wrapped — a
// partial failure leaves the field null so the UI shows
// "generating..." rather than half-rendered junk.

const SUMMARY_SYSTEM_PROMPT = `你是会议记录助手。基于一场会议的实时转录 + AI 评论,产出一份结构清晰的中文 Markdown 纪要。

要求:
- 使用以下分节,缺失内容时本节标题保留但内容写"无":
  ## 决策点
  ## 待办事项
  ## 未解问题
  ## 引用文档
- 决策/待办用编号列表,简洁直接;不要复述原文
- 待办尽量带责任人(从转录里推断)
- 不要写引言/客套话/总结性收尾
- 输出 800 字以内
- 全程客观叙述,不评论参会者表现
`;

const MAX_TRANSCRIPT_CHARS = 30_000;
const MAX_COMMENTS = 50;
const MAX_GENERATION_TIMEOUT_MS = 60_000;

// Placeholder written when a meeting ended with no transcripts/comments to
// summarize. It IS a valid (non-failure) markdown body so the UI stops polling,
// but it must NOT permanently block a later regenerate: if a recording was
// captured and later re-transcribed, the empty state should be replaceable.
// generateMeetingSummary recognizes this exact value and re-runs through it
// instead of short-circuiting on "summary already exists".
export const EMPTY_MEETING_SUMMARY =
  `## 决策点\n无\n\n## 待办事项\n无\n\n## 未解问题\n无\n\n## 引用文档\n无\n\n_(本场会议未捕获到任何转录或 ${ASSISTANT_NAME} 评论。)_`;

export interface GenerateSummaryResult {
  summaryMarkdown: string | null;
  reason: string;
}

export async function generateMeetingSummary(
  sessionId: string,
  log: FastifyBaseLogger,
): Promise<GenerateSummaryResult> {
  const session = await prisma.meetingSession.findUnique({
    where: { id: sessionId },
    select: { id: true, title: true, status: true, summaryMarkdown: true, createdAt: true, endedAt: true, createdById: true, visibility: true },
  });
  if (!session) {
    return { summaryMarkdown: null, reason: "session_not_found" };
  }
  // Short-circuit on a REAL existing summary, but NOT on the empty-meeting
  // placeholder: that placeholder is non-null only so the UI stops polling, and
  // permanently blocking regeneration would strand a meeting whose recording
  // could later be re-transcribed. Treat it as "not yet summarized" so a re-run
  // (auto or manual) can replace it once there's real material.
  if (session.summaryMarkdown && session.summaryMarkdown !== EMPTY_MEETING_SUMMARY) {
    return { summaryMarkdown: session.summaryMarkdown, reason: "already_generated" };
  }
  // Only summarize ended meetings — running summaries on a live
  // meeting would produce churn (every new transcript invalidates
  // the prior summary).
  if (session.status !== "ended") {
    return { summaryMarkdown: null, reason: "meeting_not_ended" };
  }

  const [transcripts, comments] = await Promise.all([
    prisma.meetingTranscript.findMany({
      where: { sessionId },
      orderBy: { startMs: "asc" },
      select: { text: true, startMs: true },
    }),
    prisma.meetingComment.findMany({
      where: { sessionId },
      orderBy: { atMs: "asc" },
      take: MAX_COMMENTS,
      select: { text: true, atMs: true, triggerType: true },
    }),
  ]);

  if (transcripts.length === 0 && comments.length === 0) {
    // Nothing to summarize — write an honest placeholder so the UI doesn't poll
    // forever. CAS-guarded so a concurrent writer doesn't get clobbered. If the
    // placeholder is already there (a prior empty run), re-persisting it is a
    // no-op via the CAS, so the meeting stays in a regenerate-able empty state.
    return await casPersistOrReuse(sessionId, EMPTY_MEETING_SUMMARY, "empty_meeting", log);
  }

  // Build the transcript blob, dropping the head so the most
  // recent material always makes it in (loose retro principle:
  // decisions happen at the end of a discussion).
  let transcriptBlob = transcripts
    .map((t) => `[${formatOffset(t.startMs)}] ${t.text}`)
    .join("\n");
  if (transcriptBlob.length > MAX_TRANSCRIPT_CHARS) {
    transcriptBlob = "...(早期内容已截断)\n" + transcriptBlob.slice(-MAX_TRANSCRIPT_CHARS);
  }
  const commentBlob = comments.length === 0
    ? `(无 ${ASSISTANT_NAME} 评论)`
    : comments
      .map((c) => `[${formatOffset(c.atMs)}] ${ASSISTANT_NAME}(${c.triggerType}): ${c.text}`)
      .join("\n");

  const userMessage = `会议标题:${session.title}
开始时间:${session.createdAt.toISOString()}
结束时间:${session.endedAt?.toISOString() ?? "(未结束)"}

---
[转录]
${transcriptBlob}

---
[${ASSISTANT_NAME} 评论]
${commentBlob}

请按要求输出 Markdown 纪要。`;

  // Call the LLM with a self-imposed 60s ceiling. Summary
  // generation is the only "synchronous" LLM call here — the
  // live chime path is async. 60s is generous; real meetings
  // produce <30s.
  //
  // 与在线聊天共享全局并发闸(cap 5):多场会议同时结束也不会无上限起 CLI 进程
  // 挤占交互流量。等不到槽(60s)→ 写 llm_busy 失败标记,UI 出「重新生成」按钮。
  let release: () => void;
  try {
    release = await chatSemaphore.acquire(60_000);
  } catch {
    log.warn({ event: "meeting.summary.llm_busy", sessionId }, "summary generation deferred: LLM busy");
    return await casPersistOrReuse(sessionId, MEETING_SUMMARY_FAILED_PREFIX + "llm_busy", "llm_busy", log);
  }
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), MAX_GENERATION_TIMEOUT_MS);
  let summary = "";
  try {
    const provider = await getProvider();
    for await (const chunk of provider.chat({ systemPrompt: SUMMARY_SYSTEM_PROMPT, history: [], userMessage }, ac.signal)) {
      if (chunk.type === "token") summary += chunk.text;
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
    summary = summary.trim();
  } catch (err) {
    log.error({ event: "meeting.summary.llm_failed", sessionId, err: (err as Error).message }, "summary generation failed");
    // Persist a failure marker so the UI bails out of "generating..."
    // immediately and surfaces the retry button. CAS-guarded so a
    // concurrent successful writer doesn't get overwritten with a
    // marker.
    return await casPersistOrReuse(sessionId, MEETING_SUMMARY_FAILED_PREFIX + "llm_failed", "llm_failed", log);
  } finally {
    clearTimeout(guard);
    release();
  }

  if (!summary) {
    log.warn({ event: "meeting.summary.empty_reply", sessionId }, "LLM returned empty summary");
    return await casPersistOrReuse(sessionId, MEETING_SUMMARY_FAILED_PREFIX + "empty_reply", "empty_reply", log);
  }

  const result = await casPersistOrReuse(sessionId, summary, "ok", log);
  // 群通知两道闸:① 本次调用真正写入了真实纪要(reason="ok",非 race_lost/empty/
  // failure);② 抢到该会议的一次性通知认领(minutesNotifiedAt 的 CAS)—— 手动
  // 「重新生成」会再次走到 ①,但 ② 已被首次播报占用,不会重复向群播报。
  // ② 以 claim 回调传入,在 notifyMeetingMinutes 确认「开关开着且有目标群」之后
  // 才执行:开关关着时不消耗认领,之后开启再重新生成仍能播报这场会议。
  // fire-and-forget,失败不影响纪要本身。
  if (result.reason === "ok" && result.summaryMarkdown) {
    // Web 通知(站内铃铛 + 浏览器桌面):提醒发起会议的主持人「纪要已生成」。
    // 幂等键按会议 id → 手动「重新生成」不会重复弹(dedupeKey 已存在则跳过)。fire-and-forget。
    void emitSelfNotification({
      userId: session.createdById,
      type: "meeting_minutes",
      title: `会议纪要已生成:${session.title}`,
      body: "点击查看会议纪要",
      link: `/meeting/${session.id}`,
      dedupeKey: `meeting:${session.id}`,
    });
    void notifyMeetingMinutes({
      meetingId: session.id,
      title: session.title,
      summaryMarkdown: result.summaryMarkdown,
      generatedAt: new Date(),
      visibility: session.visibility,
      claim: () => claimMinutesNotified(session.id),
      log,
    }).catch((err) => {
      log.warn({ event: "meeting.summary.notify_failed", sessionId, err: (err as Error).message }, "meeting minutes notify threw");
    });
  }
  return result;
}

// Atomic compare-and-swap on summaryMarkdown. Only writes if the
// column is still null (i.e. no concurrent writer beat us to it).
// If the swap loses, re-read and return the winner's value — the
// caller treats both outcomes the same. This is the linchpin that
// prevents concurrent POST /summary and the DELETE auto-fire from
// double-writing different LLM outputs.
async function casPersistOrReuse(
  sessionId: string,
  candidate: string,
  successReason: string,
  log: FastifyBaseLogger,
): Promise<GenerateSummaryResult> {
  try {
    // CAS matches a null summary OR the empty-meeting placeholder: a real
    // summary (or another placeholder write) may replace the placeholder, but a
    // genuine prior summary is never clobbered. Skip the redundant self-write
    // when the candidate IS the placeholder and it's already persisted — that
    // would otherwise match-and-rewrite the same bytes on every empty re-run.
    const overwritable = candidate === EMPTY_MEETING_SUMMARY
      ? [{ summaryMarkdown: null }]
      : [{ summaryMarkdown: null }, { summaryMarkdown: EMPTY_MEETING_SUMMARY }];
    const updated = await prisma.meetingSession.updateMany({
      where: { id: sessionId, OR: overwritable },
      data: { summaryMarkdown: candidate },
    });
    if (updated.count === 1) {
      log.info({ event: "meeting.summary.persisted", sessionId, chars: candidate.length, reason: successReason }, "summary persisted");
      return { summaryMarkdown: candidate, reason: successReason };
    }
    // Race lost — return whatever the winner persisted.
    const reread = await prisma.meetingSession.findUnique({
      where: { id: sessionId },
      select: { summaryMarkdown: true },
    });
    log.info({ event: "meeting.summary.race_lost", sessionId }, "summary CAS lost; returning persisted value");
    return { summaryMarkdown: reread?.summaryMarkdown ?? null, reason: "race_lost" };
  } catch (err) {
    log.error({ event: "meeting.summary.persist_failed", sessionId, err: (err as Error).message }, "summary persist failed");
    return { summaryMarkdown: null, reason: "persist_failed" };
  }
}

function formatOffset(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
