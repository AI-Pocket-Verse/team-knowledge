import { API_BASE, type ExpertChatResult, type ExpertTraceEvent } from "@/lib/api";
import { parseSseChunk } from "@/lib/sse";
import { handleUnauthorized } from "@/lib/sseAuth";
import { tr } from "@/i18n";

// 统一聊天的 SSE 消费(fetch + ReadableStream,带 cookie),走 orchestrate 总台。
// 事件:step(过程)/token(打字机)/done(权威结果)/error。在专家对话事件契约上,
// 额外透传 mentions/images/articleId —— 与首页助手平价(@引用 + 图片 + 文档内问答)。
export interface UnifiedStreamOptions {
  conversationId?: string;
  targetRoleIds?: string[];
  mentions?: { type: "doc" | "folder" | "role" | "skill"; id: string }[];
  images?: string[];
  articleId?: string | null;
  signal: AbortSignal;
  /** 服务端在开流后立刻回传本轮会话 id(新对话据此提前落定 id / 标记生成中 / 切 URL)。 */
  onMeta?(conversationId: string): void;
  onStep(event: ExpertTraceEvent): void;
  onToken(text: string): void;
  /** 思考过程逐字回推(text="" = 开始思考信号)。仅 claude + 调高 effort 时出现;缺省可不传。 */
  onThinking?(text: string): void;
  /** 思考块结束 → 收起「深度思考中」脉冲(思考文本仍可展开)。 */
  onThinkingEnd?(): void;
  onDone(result: ExpertChatResult): void;
  onError(message: string): void;
}

export async function streamUnifiedChat(message: string, o: UnifiedStreamOptions): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      conversationId: o.conversationId,
      targetRoleIds: o.targetRoleIds,
      mentions: o.mentions ?? [],
      images: o.images ?? [],
      articleId: o.articleId ?? undefined,
    }),
    signal: o.signal,
  });
  if (!res.ok) {
    if (res.status === 401) { o.onError(tr("chat.stream.expired")); void handleUnauthorized(); return; }
    if (res.status === 400) { o.onError(tr("chat.stream.empty")); return; }
    o.onError(res.status === 403 ? tr("chat.stream.forbidden") : tr("chat.stream.failedStatus", { status: res.status }));
    return;
  }
  if (!res.body) { o.onError(tr("chat.stream.noBody")); return; }

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
        if (evt.event === "meta") {
          try { const id = (JSON.parse(evt.data) as { conversationId?: string }).conversationId; if (id) o.onMeta?.(id); } catch { /* skip */ }
        } else if (evt.event === "token") {
          try { o.onToken((JSON.parse(evt.data) as { text: string }).text); } catch { /* skip */ }
        } else if (evt.event === "thinking") {
          try { o.onThinking?.((JSON.parse(evt.data) as { text: string }).text); } catch { /* skip */ }
        } else if (evt.event === "thinking_end") {
          o.onThinkingEnd?.();
        } else if (evt.event === "step") {
          try { o.onStep(JSON.parse(evt.data) as ExpertTraceEvent); } catch { /* skip */ }
        } else if (evt.event === "done") {
          try { o.onDone(JSON.parse(evt.data) as ExpertChatResult); } catch { /* skip */ }
        } else if (evt.event === "error") {
          try { o.onError((JSON.parse(evt.data) as { message?: string }).message ?? "error"); } catch { o.onError("error"); }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") o.onError((e as Error).message);
  }
}
