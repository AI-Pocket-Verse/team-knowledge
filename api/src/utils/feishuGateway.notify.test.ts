import { describe, it, expect, vi, afterEach } from "vitest";

// Tests run without WHOAMI_URL (local mode); point the gateway at a fake feishu-sso.
vi.mock("../env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env.js")>()),
  AUTH_API_BASE: "http://sso.test/api",
}));

import { feishuGateway, FeishuGatewayError } from "./feishuGateway.js";

describe("feishuGateway.notify", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to feishu-sso /feishu/notify with the internal token and returns messageId", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messageId: "om_9" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await feishuGateway.notify("ou_1", { elements: [] });
    expect(out).toEqual({ messageId: "om_9" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(String(url)).toMatch(/\/feishu\/notify$/);
    expect(init.method).toBe("POST");
    expect(init.headers["x-internal-token"]).toBeTruthy();
    expect(JSON.parse(init.body as string)).toEqual({ openId: "ou_1", card: { elements: [] } });
  });

  it("throws FeishuGatewayError on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "feishu_scope_disabled", message: "x" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ));
    await expect(feishuGateway.notify("ou_1", {})).rejects.toBeInstanceOf(FeishuGatewayError);
  });

  it("请求带超时信号；超时 → feishu_gateway_timeout(504)，不会无限等待", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(feishuGateway.notify("ou_1", {})).rejects.toMatchObject({ code: "feishu_gateway_timeout", status: 504 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("连不上网关 → feishu_gateway_unreachable(502)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(feishuGateway.notify("ou_1", {})).rejects.toMatchObject({ code: "feishu_gateway_unreachable", status: 502 });
  });
});
