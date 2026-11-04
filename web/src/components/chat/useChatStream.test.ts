import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSseChunk } from "./useChatStream";

describe("parseSseChunk", () => {
  it("splits multiple events in one chunk", () => {
    const buf = "event: token\ndata: {\"text\":\"a\"}\n\nevent: token\ndata: {\"text\":\"b\"}\n\n";
    const out = parseSseChunk(buf);
    expect(out.events).toEqual([
      { event: "token", data: "{\"text\":\"a\"}" },
      { event: "token", data: "{\"text\":\"b\"}" },
    ]);
    expect(out.rest).toBe("");
  });

  it("buffers a partial event for the next chunk", () => {
    const out = parseSseChunk("event: token\ndata: {\"text\":\"hello\"}");
    expect(out.events).toEqual([]);
    expect(out.rest).toContain("hello");
  });

  it("joins multi-line data fields", () => {
    const buf = "event: msg\ndata: line1\ndata: line2\n\n";
    const out = parseSseChunk(buf);
    expect(out.events).toEqual([{ event: "msg", data: "line1\nline2" }]);
  });

  it("tolerates CRLF line endings (proxy transcoding) — event name not polluted by \\r", () => {
    const buf = "event: token\r\ndata: {\"text\":\"a\"}\r\n\r\n";
    const out = parseSseChunk(buf);
    expect(out.events).toEqual([{ event: "token", data: "{\"text\":\"a\"}" }]);
  });
});

describe("streamChat (smoke)", () => {
  it("calls token/done callbacks for a fake stream", async () => {
    const { streamChat } = await import("./useChatStream");
    const fakeBody = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode("event: cited\ndata: {\"articleIds\":[\"a1\"],\"refs\":[{\"n\":1,\"articleId\":\"a1\",\"title\":\"X\",\"folderId\":\"m\",\"roleId\":\"r\"}]}\n\n"));
        controller.enqueue(enc.encode("event: token\ndata: {\"text\":\"hel\"}\n\nevent: token\ndata: {\"text\":\"lo\"}\n\n"));
        controller.enqueue(enc.encode("event: done\ndata: {\"ok\":true}\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: fakeBody } as unknown as Response)));

    const tokens: string[] = [];
    let cited: string[] = [];
    let done = false;
    await streamChat("hi", {
      onCited: (ids) => { cited = ids; },
      onToken: (t) => tokens.push(t),
      onDone: () => { done = true; },
      onError: () => {},
      signal: new AbortController().signal,
    });
    expect(tokens.join("")).toBe("hello");
    expect(cited).toEqual(["a1"]);
    expect(done).toBe(true);

    vi.unstubAllGlobals();
  });

  // H1 回归:发送时必须把 conversationId 写进请求体,且从 done 事件接住后端回传的
  // conversationId —— 否则 AiBubble 每轮都落到一条新建的孤儿会话(消息显示在当前会话、
  // 实际持久化到另一条),刷新后消息「消失」。
  it("发送时透传 conversationId,并从 done 接住回传 id", async () => {
    const { streamChat } = await import("./useChatStream");
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: done\ndata: {\"ok\":true,\"conversationId\":\"conv-server\"}\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchSpy);

    let doneCid: string | undefined = "UNSET";
    await streamChat("hi", {
      onCited: () => {}, onToken: () => {},
      onDone: (cid) => { doneCid = cid; },
      onError: () => {},
      signal: new AbortController().signal,
      conversationId: "conv-local",
    });

    // 请求体带上了本地会话 id
    const init0 = (fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1];
    const body = JSON.parse(init0.body) as { conversationId?: string };
    expect(body.conversationId).toBe("conv-local");
    // done 把后端回传的 id 交给了调用方
    expect(doneCid).toBe("conv-server");

    vi.unstubAllGlobals();
  });

  it("不传 conversationId 时请求体不含该字段(让后端惰性新建)", async () => {
    const { streamChat } = await import("./useChatStream");
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("event: done\ndata: {\"ok\":true}\n\n")); controller.close(); },
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchSpy);

    await streamChat("hi", {
      onCited: () => {}, onToken: () => {}, onDone: () => {}, onError: () => {},
      signal: new AbortController().signal,
    });
    const init0 = (fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1];
    const body = JSON.parse(init0.body) as Record<string, unknown>;
    expect("conversationId" in body).toBe(false);

    vi.unstubAllGlobals();
  });
});

// A 401 mid-chat is a session expiry — clear the user + bounce to
// SSO re-auth (same as api.ts), instead of surfacing a dead-end raw
// "HTTP 401". Other non-OK statuses get a friendly message; 403 is NOT
// a re-auth case.
describe("streamChat non-OK handling", () => {
  const setUser = vi.fn();
  let assign: ReturnType<typeof vi.fn>;
  let realLocation: Location;

  beforeEach(() => {
    setUser.mockClear();
    vi.resetModules();
    // useChatStream dynamically imports @/stores/auth inside the 401
    // handler; mock it so we can assert the user was cleared without
    // touching the real store (which pulls in @/lib/api side effects).
    vi.doMock("@/stores/auth", () => ({ useAuth: { getState: () => ({ setUser }) } }));
    // jsdom's window.location.assign throws "Not implemented: navigation".
    // Swap window.location for a plain stub so the redirect is observable.
    assign = vi.fn();
    realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "https://app.test/kb/chat", origin: "https://app.test", assign },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/stores/auth");
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  });

  it("on 401: clears the user, redirects to SSO login, and reports a friendly message", async () => {
    const { streamChat } = await import("./useChatStream");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, body: null } as unknown as Response)));

    let err = "";
    await streamChat("hi", {
      onCited: () => {}, onToken: () => {}, onDone: () => {},
      onError: (m) => { err = m; },
      signal: new AbortController().signal,
    });
    // handleUnauthorized awaits a dynamic import; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toContain("登录已过期");
    expect(setUser).toHaveBeenCalledWith(null);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]![0]).toContain("/login?return_to=");
  });

  it("on 403: reports a friendly message and does NOT redirect", async () => {
    const { streamChat } = await import("./useChatStream");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, body: null } as unknown as Response)));

    let err = "";
    await streamChat("hi", {
      onCited: () => {}, onToken: () => {}, onDone: () => {},
      onError: (m) => { err = m; },
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toContain("权限");
    expect(assign).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
  });
});
