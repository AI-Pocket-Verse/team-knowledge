import { useEffect } from "react";
import { api } from "@/lib/api";
import { parseSseChunk } from "@/lib/sse";
import { handleUnauthorized } from "@/lib/sseAuth";
import { useChatStore } from "@/stores/chat";

const RECONNECT_MS = 3000;

function parse(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// 当前正在查看的会话是否为飞书专用会话。飞书发起的远程轮次落在飞书会话,
// 只有用户此刻正看着它时,才把打字机镜像进消息流;否则只在收尾刷新列表。
function isViewingFeishu(): boolean {
  const st = useChatStore.getState();
  return !!st.conversations.find((c) => c.id === st.conversationId)?.isFeishu;
}

// 收敛到「当前会话」:刷新会话列表(排序/未读位次)+ 重拉当前会话的消息
//(实时流式中由 store 内 same-id 守卫自然跳过重拉,不会冲掉进行中的草稿)。
// 唯一不重拉的情形:当前会话最后一条 assistant 是本地刚渲染、带 trace 的专家终稿 ——
// 服务端重拉拿不到 trace(它不落库),重拉会把 trace 抹掉,故跳过。其余一律重拉,尤其
// 「切回一条后台仍在生成 / 刚完成的会话」必须重拉才能把落库的答复显示出来。
function refreshActive(): void {
  const st = useChatStore.getState();
  void st.loadConversations().catch(() => { /* next nudge retries */ });
  if (!st.conversationId) return;
  const last = st.messages[st.messages.length - 1];
  const protectLocalTrace = st.status !== "streaming"
    && last?.role === "assistant" && (last.trace?.length ?? 0) > 0;
  if (protectLocalTrace) return;
  void st.switchConversation(st.conversationId).catch(() => { /* retried */ });
}

// 远程轮次(飞书发起)的完整流式镜像:remote_start 落问题 + 锁输入框,
// remote_token/remote_thinking 逐字打出,remote_done/remote_error 解锁并
// 重拉当前会话。多会话下:远程打字机只在「正看着飞书会话」时驱动;update 是通用
//「会话变了」提示(其它来源,如助手通知)→ 刷新列表 + 重拉当前会话;
// hello 在重连后兜底解锁(断线期间可能漏掉 remote_done)。
export function handleEvent(event: string, data: string): void {
  const st = useChatStore.getState();
  switch (event) {
    case "update":
      refreshActive();
      break;
    case "remote_start": {
      const p = parse(data);
      // 不在飞书会话页时,忽略打字机(remoteStreaming 保持 false → 后续 token/thinking
      // 的 remoteStreaming 守卫自然跳过),收尾的 remote_done 再刷新列表。
      if (isViewingFeishu() && typeof p?.text === "string") {
        const images = Array.isArray((p as { images?: unknown }).images)
          ? ((p as { images: unknown[] }).images.filter((u): u is string => typeof u === "string"))
          : [];
        st.remoteStart(p.text, images);
      }
      break;
    }
    case "remote_token": {
      const p = parse(data);
      if (st.remoteStreaming && typeof p?.text === "string") st.appendAssistantToken(p.text);
      break;
    }
    case "remote_thinking": {
      const p = parse(data);
      if (st.remoteStreaming) st.appendAssistantThinking(typeof p?.text === "string" ? p.text : "");
      break;
    }
    case "remote_thinking_end":
      if (st.remoteStreaming) st.endAssistantThinking();
      break;
    case "remote_cited": {
      const p = parse(data);
      if (st.remoteStreaming && Array.isArray(p?.refs)) {
        st.setAssistantRefs(p.refs as Parameters<typeof st.setAssistantRefs>[0]);
      }
      break;
    }
    case "remote_done":
    case "remote_error":
      if (st.remoteStreaming) st.remoteFinish();
      refreshActive();
      break;
    case "hello":
      // Reconnected mid-remote-turn: we may have missed remote_done while
      // offline — resync instead of leaving the composer locked forever.
      if (st.remoteStreaming) {
        st.remoteFinish();
        refreshActive();
      }
      break;
    // ping ignored
  }
}

// Subscribe to GET /api/chat/stream (fetch + ReadableStream, cookie auth —
// same pattern as useDashboardStream). The server pushes an "update" nudge
// whenever a chat turn lands OFF this page(飞书单聊、助手后台通知),and we
// refetch the conversation. hydrate() 自带 idle 竞态保护:本页正在发送/流式
// 输出时直接跳过,不会覆盖进行中的消息。
//
// Mount once app-wide (WorkspaceShell) — AiBubble 与 HomeChatPanel 共享同一
// chat store,一条订阅同时服务两个聊天界面。
export function useChatUpdates(): void {
  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect(): Promise<void> {
      try {
        const res = await fetch(api.chat.streamUrl(), { credentials: "include", signal: ac.signal });
        if (!res.ok) {
          if (res.status === 401) { void handleUnauthorized(); return; } // terminal
          throw new Error(`stream ${res.status}`); // transient → reconnect
        }
        if (!res.body) throw new Error("no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buf);
          buf = rest;
          for (const evt of events) handleEvent(evt.event, evt.data);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // unmounted — no reconnect
      }
      if (!stopped) {
        reconnectTimer = setTimeout(() => { void connect(); }, RECONNECT_MS);
      }
    }

    void connect();
    return () => {
      stopped = true;
      ac.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);
}
