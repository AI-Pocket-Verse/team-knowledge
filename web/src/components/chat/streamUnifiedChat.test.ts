import { describe, it, expect, vi } from "vitest";

describe("streamUnifiedChat", () => {
  it("假流:step/token/done 各回调,且 body 带 mentions/images/articleId/targetRoleIds", async () => {
    const { streamUnifiedChat } = await import("./streamUnifiedChat");
    const fakeBody = new ReadableStream({
      start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode('event: step\ndata: {"type":"routed","roleIds":["r1"]}\n\n'));
        c.enqueue(e.encode('event: token\ndata: {"text":"答"}\n\n'));
        c.enqueue(e.encode('event: done\ndata: {"answer":"答完","trace":[],"citations":[],"conversationId":"c1"}\n\n'));
        c.close();
      },
    });
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, body: fakeBody } as unknown as Response));
    vi.stubGlobal("fetch", fetchSpy);

    const steps: string[] = []; const tokens: string[] = []; let answer = "";
    await streamUnifiedChat("问", {
      targetRoleIds: ["r1"],
      mentions: [{ type: "doc", id: "d1" }],
      images: ["/uploads/x.png"],
      articleId: "a9",
      signal: new AbortController().signal,
      onStep: (e) => steps.push(e.type),
      onToken: (t) => tokens.push(t),
      onDone: (r) => { answer = r.answer; },
      onError: () => {},
    });
    expect(steps).toEqual(["routed"]);
    expect(tokens.join("")).toBe("答");
    expect(answer).toBe("答完");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ message: "问", targetRoleIds: ["r1"], mentions: [{ type: "doc", id: "d1" }], images: ["/uploads/x.png"], articleId: "a9" });
    vi.unstubAllGlobals();
  });

  it("非 OK(403)→ 友好错误,不抛", async () => {
    const { streamUnifiedChat } = await import("./streamUnifiedChat");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, body: null } as unknown as Response)));
    let err = "";
    await streamUnifiedChat("问", { signal: new AbortController().signal, onStep: () => {}, onToken: () => {}, onDone: () => {}, onError: (m) => { err = m; } });
    expect(err).toContain("权限");
    vi.unstubAllGlobals();
  });
});
