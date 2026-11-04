import type { FastifyBaseLogger } from "fastify";
import type { MeetingCommentTrigger } from "@team-knowledge/shared";
import { prisma } from "../../db.js";
import { search } from "../retrieval/fts5.js";
import { getProvider } from "../llm/registry.js";
import { getTtsProvider } from "../tts/registry.js";
import { ttsSynthesisSemaphore } from "../../utils/concurrency.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";
import { appLang } from "../../utils/lang.js";
import { outputLanguageInstruction } from "../llm/language.js";

// ─── assistant speaker ────────────────────────────────────────────
// Given a trigger, generate the chime-in comment, persist it, and
// produce a broadcast-ready payload (text + citations + tts URL).
// Wires together:
//   * existing FTS5 retrieval (services/retrieval/fts5.ts)
//   * existing LLM provider (services/llm/registry.ts)
//   * new TTS provider (services/tts/registry.ts)
//
// Permission model: the asker's team-knowledge permissions decide what
// docs assistant can see (the viewer's own perms). Meeting-scope
// roleIds further narrow the retrieval so e.g. a question asked
// in a product-only meeting doesn't surface client-team docs even
// if the asker happens to have access to those too.
//
// Output is a complete payload — meeting-ws.ts handles the actual
// WebSocket broadcast + the trigger engine bookkeeping
// (recordComment) AFTER this returns successfully.

const ASSISTANT_SYSTEM_PROMPT = `你是 ${ASSISTANT_NAME},一个在企业会议里实时旁听、像同事一样参与讨论的 AI。
任务:结合检索到的知识库内容,对当前讨论简短地发表你的看法或回答。

要求:
- 用中文口语化地说,1-2 句话,总共不超过 50 个字,像真人插一句话,不要 markdown、不要列表
- 可以自然地用「我说一下」「我的看法是」「我发表一下意见」这类开场,但不必每次都加
- 直接说观点或结论,不要复述别人刚说的话
- 不要在发言里提到你参考了哪些文档,也不要用「根据《xxx》」这种措辞 —— 相关文档会单独以链接形式附在你发言后面,无需在正文里点名
- 知识库里没有相关内容时,就结合讨论正常发表看法即可,不要硬扯文档、也不要瞎编
`;

const ASSISTANT_CONTEXT_HEADER = "[相关文档]";
const ASSISTANT_TRANSCRIPT_HEADER = "[最近对话]";
const ASSISTANT_TRIGGER_HEADER = "[触发原因]";
const ASSISTANT_QUESTION_HEADER = "[用户问题]";

const MAX_DOC_CHARS = 4_000;
const MAX_DOCS = 3;
const MAX_REPLY_TIMEOUT_MS = 30_000;

export type SpeakerTrigger = MeetingCommentTrigger;

// Sentence boundaries for the streaming TTS path. We synthesize +
// emit audio one sentence at a time so sentence 0 starts playing
// while sentence 1's text is still streaming in. A clause that runs
// past SENTENCE_CHAR_CAP without hitting a terminator is flushed
// anyway so a long run-on doesn't starve the audio.
const SENTENCE_TERMINATORS = /[。！？!?；;\n]/;
const SENTENCE_CHAR_CAP = 40;

export interface SpeakInput {
  sessionId: string;
  // The meeting's allowedRoleIds — narrows retrieval scope.
  allowedRoleIds: string[];
  // Whoever's permissions to use for retrieval. For natural
  // triggers (keyword / silence) this is the meeting host (the
  // person whose audio drove the transcript). For manual asks,
  // the asker's id (so we don't accidentally leak past their
  // own permissions).
  askerUserId: string;
  askerIsAdmin: boolean;
  // Recent transcript text (provided by the trigger engine).
  recentTranscript: string;
  trigger: SpeakerTrigger;
  // For user_question: the explicit question. For other triggers,
  // omitted — assistant generates an unprompted comment.
  question?: string;
  // ms offset since meeting start, used for atMs on MeetingComment.
  atMs: number;
  // Display name for the asker (used for triggeredByName in the
  // serialized broadcast).
  askerName: string | null;
  // Optional caller-supplied signal that gets composed with the
  // speaker's own 30s timeout. The caller (meeting-ws) aborts it
  // when the meeting ends so we don't strand an in-flight LLM
  // call + then write a comment row no participant ever saw.
  abortSignal?: AbortSignal;
}

// Streaming lifecycle callbacks. The caller (meeting-ws) turns each
// into a WebSocket broadcast. Generation streams the LLM tokens as
// `onDelta`, synthesizes + emits TTS per sentence as `onSentenceTts`,
// and finishes with `onDone` carrying the full text + citations.
export interface SpeakStreamCallbacks {
  /** 第一个 token 到来、MeetingComment 行已存在(text="", no tts)。 */
  onStart(meta: {
    id: string;
    triggerType: SpeakerTrigger;
    triggeredByUserId: string | null;
    triggeredByName: string | null;
    atMs: number;
    createdAt: string;
  }): void;
  /** A token / small batch of new text streamed from the LLM. */
  onDelta(id: string, text: string): void;
  /** One sentence finished synthesizing → its clip url + monotonic seq. */
  onSentenceTts(id: string, seq: number, audioUrl: string): void;
  /** Generation finished: final full text + cited article ids + resolved
   *  cited refs (id + title) for the clickable doc links shown after the
   *  comment. The row's text + citedArticleIds have already been persisted. */
  onDone(id: string, text: string, citedArticleIds: string[], citedRefs: { articleId: string; title: string }[]): void;
}

// Outcome of a streaming run, so the caller can decide whether to
// record the comment against the freq limit. `started` is false when
// retrieval/persist failed or generation produced no text (the caller then
// surfaces assistant_skipped instead; no start frame was ever sent).
export interface SpeakStreamResult {
  started: boolean;
}

// Compose the assistant prompt. Kept inline for clarity — easy to
// iterate on once we see real meeting transcripts.
function buildAssistantPrompt(input: SpeakInput, docs: { title: string; body: string }[]): {
  systemPrompt: string;
  userMessage: string;
} {
  const docBlocks = docs.slice(0, MAX_DOCS).map((d, i) => {
    const truncated = d.body.length > MAX_DOC_CHARS
      ? d.body.slice(0, MAX_DOC_CHARS) + "...(已截断)"
      : d.body;
    return `《${d.title}》(文档 ${i + 1}):\n${truncated}`;
  }).join("\n\n");

  const parts: string[] = [];
  if (docBlocks) parts.push(`${ASSISTANT_CONTEXT_HEADER}\n${docBlocks}`);
  if (input.recentTranscript) parts.push(`${ASSISTANT_TRANSCRIPT_HEADER}\n${input.recentTranscript}`);
  parts.push(`${ASSISTANT_TRIGGER_HEADER}\n${triggerLabel(input.trigger)}`);
  if (input.question) parts.push(`${ASSISTANT_QUESTION_HEADER}\n${input.question}`);

  return {
    systemPrompt: ASSISTANT_SYSTEM_PROMPT + outputLanguageInstruction(appLang()),
    userMessage: parts.join("\n\n"),
  };
}

function triggerLabel(t: SpeakerTrigger): string {
  switch (t) {
    case "explicit_wake":  return `有人在会议里直接 @ ${ASSISTANT_NAME}。`;
    case "keyword":        return "对话中提到了之前的方案/文档,建议补充背景。";
    case "silence":        return "讨论冷场,有未解的问题。请总结并给出方向。";
    case "proactive":      return "讨论正在进行,请你主动结合知识库,补充相关背景、要点或提醒,简洁地参与讨论。";
    case "manual_button":  return `主持人点击「让 ${ASSISTANT_NAME} 评论刚才」。`;
    case "user_question":  return `参会者直接向 ${ASSISTANT_NAME} 提问。`;
  }
}

// Drive the existing chat provider as a token stream. The same
// LLMProvider.chat() the web chat path uses (services/llm/registry.ts)
// already yields `{ type:"token", text }` chunks incrementally — we
// just forward each one instead of buffering to a single string. Non-
// fatal "thinking"/"done" chunks are ignored; "error" throws.
async function* streamTokens(systemPrompt: string, userMessage: string, signal: AbortSignal): AsyncGenerator<string> {
  const provider = await getProvider();
  for await (const chunk of provider.chat({ systemPrompt, history: [], userMessage }, signal)) {
    if (chunk.type === "token") yield chunk.text;
    else if (chunk.type === "error") throw new Error(chunk.message);
  }
}

// Streaming assistant comment. Replaces the old atomic generate→synthesize→
// broadcast-once flow: tokens stream out as `onDelta` while each completed
// sentence is synthesized + emitted as `onSentenceTts` concurrently, so
// sentence 0's audio plays while sentence 1's text is still streaming. The
// MeetingComment row is created up-front (text="", ttsAudioUrl=null) and
// updated with the final text + citations on `onDone`.
//
// Persistence trade-off: streamed comments keep ttsAudioUrl=null in the DB.
// Live TTS is the per-sentence streamed clips (played as they arrive); we do
// NOT stitch them into a single persisted file, so post-meeting replay of
// assistant's *voice* is dropped — only the text is retained (loaded via REST in
// the ended-meeting timeline). The whole-comment TTS path is gone with the
// atomic flow.
export async function streamAssistantComment(
  input: SpeakInput,
  cb: SpeakStreamCallbacks,
  log: FastifyBaseLogger,
): Promise<SpeakStreamResult> {
  // Retrieve docs. FTS5.search 本身不做可见性闸门(见 retrieval/fts5.ts),
  // 这里只按会议的 allowedRoleIds 在检索结果上收窄;空范围表示「不额外收窄」
  // (会议创建时没有角色范围,如无角色的主持人),此时不能对空集合过滤,
  // 否则会把结果全部丢掉。
  const query = input.question ?? input.recentTranscript.slice(-200);
  let hits: { articleId: string; title: string; body: string; roleId: string }[] = [];
  if (query.trim().length > 0) {
    try {
      const raw = await search({
        query, userId: input.askerUserId, isAdmin: input.askerIsAdmin, limit: 10,
      });
      const allowed = new Set(input.allowedRoleIds);
      hits = raw
        .filter((h) => allowed.size === 0 || allowed.has(h.roleId))
        .slice(0, MAX_DOCS);
    } catch (err) {
      log.warn({ event: "assistant.retrieval_failed", sessionId: input.sessionId, err: (err as Error).message }, "retrieval failed; proceeding without docs");
    }
  }

  // If the caller already aborted (meeting ended during retrieval), bail
  // before creating a row that nobody will see.
  if (input.abortSignal?.aborted) {
    log.info({ event: "assistant.aborted_pre_persist", sessionId: input.sessionId }, "assistant aborted by caller; skipping persist");
    return { started: false };
  }

  const citedArticleIds = hits.map((h) => h.articleId);
  // Resolved (id + title) refs for the post-comment links. Titles come from
  // the retrieval hits in memory — no extra query. The live WS path forwards
  // these directly; the REST reload path re-resolves titles from the row.
  const citedRefs = hits.map((h) => ({ articleId: h.articleId, title: h.title }));

  // Create the row up-front so deltas have a stable id to address.
  // text starts empty; it + citations are written on done.
  let row;
  try {
    row = await prisma.meetingComment.create({
      data: {
        sessionId: input.sessionId,
        triggerType: input.trigger,
        triggeredByUserId: input.askerUserId,
        text: "",
        citedArticleIds: null,
        atMs: input.atMs,
        // ttsAudioUrl stays null — streamed comments use per-sentence
        // live clips, not a persisted whole-comment file (see header).
      },
    });
  } catch (err) {
    log.error({ event: "assistant.persist_failed", sessionId: input.sessionId, err: (err as Error).message }, "comment persist failed");
    return { started: false };
  }
  const id = row.id;
  // start 帧延迟到第一个 token 到来时再发:生成失败 / 空文本时客户端从未见过这条发言,
  // 不会留下永远转圈的空气泡。
  let startSent = false;
  const sendStart = () => {
    if (startSent) return;
    startSent = true;
    cb.onStart({
      id,
      triggerType: input.trigger,
      triggeredByUserId: input.askerUserId,
      triggeredByName: input.askerName,
      atMs: input.atMs,
      createdAt: row.createdAt.toISOString(),
    });
  };

  // Build prompt + stream the LLM with a self-imposed 30s timeout so a
  // hung CLI can't camp on the channel forever. The caller may pass an
  // AbortSignal of their own (e.g. meeting shutdown) — we compose them so
  // EITHER cancellation stops the token stream AND skips pending TTS.
  const { systemPrompt, userMessage } = buildAssistantPrompt(input, hits);
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), MAX_REPLY_TIMEOUT_MS);
  const onUpstreamAbort = () => ac.abort();
  if (input.abortSignal) {
    if (input.abortSignal.aborted) ac.abort();
    else input.abortSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  // Per-sentence TTS pipeline. We accumulate streamed text into a sentence
  // buffer; each completed sentence is synthesized in the BACKGROUND (so
  // token streaming never blocks on TTS) and emitted with a monotonic seq.
  // The client orders playback by (comment arrival, seq). Aborting skips any
  // sentence not yet dispatched and the synthesize() call no-ops on abort.
  let ttsSeq = 0;
  const ttsTasks: Promise<void>[] = [];
  const dispatchSentence = (sentence: string) => {
    const s = sentence.trim();
    if (!s) return;
    if (ac.signal.aborted) return;
    const seq = ttsSeq++;
    ttsTasks.push((async () => {
      if (ac.signal.aborted) return;
      // Bound concurrent TTS WebSockets globally (cap 6): a long comment's N
      // sentences × M meetings would otherwise open N×M simultaneous outbound
      // volc WS. Sentences are played FIFO client-side, so a brief queue here
      // doesn't change perceived ordering. Acquire with a timeout so a wedged
      // cap can't strand the sentence forever; on timeout we skip the clip.
      let release: (() => void) | null = null;
      try {
        release = await ttsSynthesisSemaphore.acquire(MAX_REPLY_TIMEOUT_MS);
      } catch {
        log.warn({ event: "assistant.tts_semaphore_busy", sessionId: input.sessionId, commentId: id, seq }, "tts synthesis cap saturated; skipping clip");
        return;
      }
      try {
        if (ac.signal.aborted) return;
        const tts = await getTtsProvider();
        if (ac.signal.aborted) return;
        const synth = await tts.synthesize({ text: s, sessionId: input.sessionId, commentId: id, seq });
        if (ac.signal.aborted) return;
        if (synth.audioUrl) cb.onSentenceTts(id, seq, synth.audioUrl);
      } catch (err) {
        log.warn({ event: "assistant.tts_failed", sessionId: input.sessionId, commentId: id, seq, err: (err as Error).message }, "sentence tts failed; skipping clip");
      } finally {
        release();
      }
    })());
  };

  // Split a growing buffer into completed sentences. Returns the leftover
  // (incomplete) tail. A clause that exceeds SENTENCE_CHAR_CAP without a
  // terminator is flushed at the cap so long run-ons don't starve audio.
  const flushSentences = (buf: string): string => {
    let rest = buf;
    for (;;) {
      const m = SENTENCE_TERMINATORS.exec(rest);
      if (m) {
        const end = m.index + 1;
        dispatchSentence(rest.slice(0, end));
        rest = rest.slice(end);
        continue;
      }
      if (rest.length > SENTENCE_CHAR_CAP) {
        dispatchSentence(rest.slice(0, SENTENCE_CHAR_CAP));
        rest = rest.slice(SENTENCE_CHAR_CAP);
        continue;
      }
      break;
    }
    return rest;
  };

  let full = "";
  let pending = ""; // buffer of text not yet flushed into a sentence
  try {
    for await (const tok of streamTokens(systemPrompt, userMessage, ac.signal)) {
      if (!tok) continue;
      full += tok;
      // 开头的纯空白先不发:若随后出错,客户端从未见过这条发言,不会留下空气泡。
      if (!full.trim()) continue;
      sendStart();
      cb.onDelta(id, tok);
      pending += tok;
      pending = flushSentences(pending);
    }
    // Flush whatever's left as a trailing sentence (no terminator).
    if (pending.trim()) dispatchSentence(pending);
  } catch (err) {
    log.error({ event: "assistant.generation_failed", sessionId: input.sessionId, err: (err as Error).message }, "assistant generation failed");
  } finally {
    clearTimeout(guard);
    if (input.abortSignal) input.abortSignal.removeEventListener("abort", onUpstreamAbort);
  }

  // Let any in-flight sentence TTS settle (best-effort) so their clips land
  // before done. Aborted tasks no-op quickly; this never throws.
  await Promise.allSettled(ttsTasks);

  const text = full.trim();
  // 没有任何产出(LLM 报错 / 超时 / 空文本):撤掉占位行,告诉调用方没开始,
  // 调用方据此提示用户且不计入频控。已有部分文本时中途出错则保留已生成的部分。
  if (!text) {
    await prisma.meetingComment.delete({ where: { id } }).catch((err) => {
      log.error({ event: "assistant.placeholder_cleanup_failed", sessionId: input.sessionId, commentId: id, err: (err as Error).message }, "empty comment cleanup failed");
    });
    return { started: false };
  }
  // Persist the final text + citations onto the row created up-front.
  try {
    await prisma.meetingComment.update({
      where: { id },
      data: {
        text,
        citedArticleIds: citedArticleIds.length > 0 ? JSON.stringify(citedArticleIds) : null,
      },
    });
  } catch (err) {
    log.error({ event: "assistant.finalize_failed", sessionId: input.sessionId, commentId: id, err: (err as Error).message }, "comment finalize failed");
  }
  cb.onDone(id, text, citedArticleIds, citedRefs);
  return { started: true };
}
