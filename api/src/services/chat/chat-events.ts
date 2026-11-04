// Per-user chat update fanout — lets the web chat UI refresh in realtime when
// a turn lands from OUTSIDE the page itself (Feishu p2p chat, conversational
// assistant notify). In-memory only (single-process deploy), mirroring the
// dashboard stream's subscriber-set pattern: the SSE route subscribes one
// writer per connection, runChatTurn/assistantNotify publish after persisting.
// Payload is just a "something changed" nudge — the client refetches the
// conversation (hydrate), so no message content travels on this channel.
import type { SseWriter } from "../../utils/sse.js";

const subscribers = new Map<string, Set<SseWriter>>();

export function subscribeChatEvents(userId: string, sse: SseWriter): void {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set();
    subscribers.set(userId, set);
  }
  set.add(sse);
}

export function unsubscribeChatEvents(userId: string, sse: SseWriter): void {
  const set = subscribers.get(userId);
  if (!set) return;
  set.delete(sse);
  if (set.size === 0) subscribers.delete(userId);
}

/** Push a named event to all of a user's open chat streams. Besides the
 *  generic "update" nudge, the feishu-originated turn mirrors its full
 *  streaming lifecycle here (remote_start / remote_cited / remote_thinking /
 *  remote_token / remote_done / remote_error) so the web UI renders the same
 *  typewriter experience as a turn it started itself. */
export function publishChatEvent(userId: string, event: string, payload: unknown): void {
  const set = subscribers.get(userId);
  if (!set) return;
  for (const sse of set) sse.send(event, payload);
}

/** Nudge all of a user's open chat streams that the conversation changed. */
export function publishChatUpdate(userId: string, payload: { source: string }): void {
  publishChatEvent(userId, "update", payload);
}

/** Test-only: active subscriber count for a user. */
export function __chatEventSubscriberCount(userId: string): number {
  return subscribers.get(userId)?.size ?? 0;
}
