import { API_BASE } from "@/lib/api";
import { parseSseChunk, type SseEvent } from "@/lib/sse";
import { handleUnauthorized } from "@/lib/sseAuth";
import { tr } from "@/i18n";

// parseSseChunk / SseEvent moved to @/lib/sse (shared with the dashboard
// stream); re-exported here so existing callers + tests that import them from
// this module keep working.
export { parseSseChunk };
export type { SseEvent };

export interface StreamRef {
  n: number;
  articleId: string;
  title: string;
  folderId: string;
  roleId: string;
}

export interface StreamHandlers {
  onCited(articleIds: string[], refs: StreamRef[]): void;
  onToken(text: string): void;
  /** Extended-thinking delta. text === "" is the "thinking block
   *  opened" signal (use it to flip a deep-thinking indicator on);
   *  non-empty is incremental reasoning text. Optional — providers
   *  that don't surface thinking simply never fire it, so the UI
   *  badge stays hidden for non-thinking models. */
  onThinking?(text: string): void;
  /** Paired with the first onThinking call; flip the indicator off. */
  onThinkingEnd?(): void;
  /** done 事件。服务端按当前/惰性新建的会话回传 conversationId,首发新会话时调用方
   *  据此把它落定到 store(否则每次发送都会落到一条新建的孤儿会话)。 */
  onDone(conversationId?: string): void;
  onError(message: string): void;
  signal: AbortSignal;
  /** 本轮所属会话 id。省略 = 让服务端惰性新建一条(首发);务必在 onDone 里接住回传 id。 */
  conversationId?: string | null;
  // When the user opens the AI panel while reading an article, the
  // caller forwards that article id so the server can prepend it to
  // the retrieval list — effectively scoping the chat to "this doc".
  articleId?: string | null;
  // Structured @-mentions attached to the message via the chip
  // selector. Server resolves labels from the database — the wire
  // payload here only carries {type, id}.
  mentions?: { type: "doc" | "folder" | "role" | "skill"; id: string }[];
  // 随消息附带的图片(/uploads/<file>,先经 api.uploads.image 上传)。
  images?: string[];
}

export async function streamChat(content: string, h: StreamHandlers): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/message`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      ...(h.conversationId ? { conversationId: h.conversationId } : {}),
      articleId: h.articleId ?? null,
      mentions: h.mentions ?? [],
      images: h.images ?? [],
    }),
    signal: h.signal,
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Session expired — bounce to SSO re-auth (same as api.ts).
      h.onError(tr("chat.stream.expired"));
      void handleUnauthorized();
      return;
    }
    h.onError(res.status === 403 ? tr("chat.stream.forbidden") : tr("chat.stream.failedStatus", { status: res.status }));
    return;
  }
  if (!res.body) { h.onError(tr("chat.stream.noBody")); return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buf);
      buf = rest;
      for (const evt of events) {
        if (evt.event === "token") {
          try { h.onToken((JSON.parse(evt.data) as { text: string }).text); } catch { /* skip */ }
        } else if (evt.event === "thinking") {
          try { h.onThinking?.((JSON.parse(evt.data) as { text: string }).text); } catch { /* skip */ }
        } else if (evt.event === "thinking_end") {
          h.onThinkingEnd?.();
        } else if (evt.event === "cited") {
          try {
            const p = JSON.parse(evt.data) as { articleIds?: string[]; refs?: StreamRef[] };
            h.onCited(p.articleIds ?? [], p.refs ?? []);
          } catch { /* skip */ }
        } else if (evt.event === "done") {
          let cid: string | undefined;
          try { cid = (JSON.parse(evt.data) as { conversationId?: string }).conversationId; } catch { /* no id */ }
          h.onDone(cid);
        } else if (evt.event === "error") {
          try { h.onError((JSON.parse(evt.data) as { message?: string }).message ?? "error"); } catch { h.onError("error"); }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") h.onError((e as Error).message);
  }
}
