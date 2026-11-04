// Stateless group chat turn for "@assistant" in a Feishu group. PRIVACY-CRITICAL:
// a group answer is visible to EVERYONE in the group, so this path may only use
// PUBLIC knowledge. It retrieves via search() ONLY (the whole doc library: there is
// no draft status, and search() applies no per-viewer visibility filter), and
// deliberately passes NO articleId / NO @-mentions / NO history — the three ways
// private/draft content could otherwise enter the prompt. It also persists
// nothing (no Conversation, no ChatMessage): each group @ is a one-shot.
import type { FastifyBaseLogger } from "fastify";
import { search } from "../retrieval/fts5.js";
import { buildChatPrompt } from "../prompt/build.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import type { ChatTurnChunk } from "./runChatTurn.js";
import { L, appLang, type Lang } from "../../utils/lang.js";

export interface RunGroupChatTurnArgs {
  text: string;
  /** 随 @ 消息附带的图片【绝对路径】(调用方已校验归属并落盘)。 */
  images?: string[];
  signal: AbortSignal;
  onChunk: (c: ChatTurnChunk) => void;
  log: FastifyBaseLogger;
}

export async function runGroupChatTurn(args: RunGroupChatTurnArgs): Promise<void> {
  const { text, signal, onChunk, log } = args;
  const images = args.images ?? [];

  let release: () => void;
  try {
    release = await chatSemaphore.acquire(30_000);
  } catch {
    onChunk({ type: "error", message: L(appLang(), "AI 当前繁忙，请稍后再试", "The AI is busy right now. Please try again later.") });
    return;
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    // Public-knowledge retrieval only. search() applies no per-user private
    // dimension, so nothing here is scoped to any individual. No mentions, no
    // articleId, no history are passed to buildChatPrompt.
    const promptText = text.trim() || "(我发了图片,请查看图片内容并回应。)";
    const retrieved = await search({ query: promptText, userId: "", isAdmin: false, limit: 5 });
    const built = buildChatPrompt({ retrieved, history: [], userMessage: promptText });

    const provider = await getProvider();
    const iter = provider.chat(
      { systemPrompt: built.systemPrompt, history: built.history, userMessage: built.userMessage },
      ac.signal,
      images.length > 0 ? { images } : undefined,
    );

    let replyLen = 0;
    for await (const chunk of iter) {
      if (chunk.type === "token") { replyLen += chunk.text.length; onChunk(chunk); }
      else if (chunk.type === "done") {
        log.info({ event: "chat.turn", scope: "group", replyLen }, "group chat turn completed");
        onChunk({ type: "done" });
      } else if (chunk.type === "error") onChunk(chunk);
      // thinking / thinking_end: not surfaced in group cards.
    }
  } catch (e) {
    onChunk({ type: "error", message: (e as Error).message });
  } finally {
    signal.removeEventListener("abort", onAbort);
    release();
  }
}
