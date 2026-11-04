import { describe, it, expect, vi } from "vitest";
import {
  subscribeChatEvents, unsubscribeChatEvents, publishChatUpdate, publishChatEvent, __chatEventSubscriberCount,
} from "./chat-events.js";
import type { SseWriter } from "../../utils/sse.js";

function fakeSse() {
  return { send: vi.fn<SseWriter["send"]>(), comment: vi.fn<SseWriter["comment"]>(), end: vi.fn<SseWriter["end"]>() };
}

describe("chat-events", () => {
  it("delivers updates to all of the user's subscribers, and only theirs", () => {
    const a1 = fakeSse(), a2 = fakeSse(), b = fakeSse();
    subscribeChatEvents("user-a", a1);
    subscribeChatEvents("user-a", a2);
    subscribeChatEvents("user-b", b);

    publishChatUpdate("user-a", { source: "feishu" });

    expect(a1.send).toHaveBeenCalledWith("update", { source: "feishu" });
    expect(a2.send).toHaveBeenCalledWith("update", { source: "feishu" });
    expect(b.send).not.toHaveBeenCalled();

    unsubscribeChatEvents("user-a", a1);
    unsubscribeChatEvents("user-a", a2);
    unsubscribeChatEvents("user-b", b);
  });

  it("publishChatEvent delivers arbitrary named events (remote_* lifecycle)", () => {
    const s = fakeSse();
    subscribeChatEvents("user-d", s);
    publishChatEvent("user-d", "remote_start", { text: "你好" });
    publishChatEvent("user-d", "remote_token", { text: "答" });
    publishChatEvent("user-d", "remote_done", {});
    expect(s.send.mock.calls).toEqual([
      ["remote_start", { text: "你好" }],
      ["remote_token", { text: "答" }],
      ["remote_done", {}],
    ]);
    unsubscribeChatEvents("user-d", s);
  });

  it("publish with no subscribers is a no-op", () => {
    expect(() => publishChatUpdate("nobody", { source: "web" })).not.toThrow();
  });

  it("unsubscribe stops delivery and empties the registry", () => {
    const s = fakeSse();
    subscribeChatEvents("user-c", s);
    expect(__chatEventSubscriberCount("user-c")).toBe(1);
    unsubscribeChatEvents("user-c", s);
    expect(__chatEventSubscriberCount("user-c")).toBe(0);
    publishChatUpdate("user-c", { source: "feishu" });
    expect(s.send).not.toHaveBeenCalled();
  });
});
