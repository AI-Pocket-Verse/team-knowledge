import { describe, it, expect, vi, afterEach } from "vitest";

import { feishuGateway, FeishuGatewayError } from "./feishuGateway.js";

// Tests run without WHOAMI_URL, i.e. local single-user mode: every Feishu call
// must fail fast with a distinguishable error instead of fetching "undefined/…".
describe("feishuGateway without feishu-sso (local mode)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects bot pushes and doc reads with feishu_not_configured, without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const call of [
      () => feishuGateway.notify("ou_1", { elements: [] }),
      () => feishuGateway.getDocxMeta("sso_session=x", "doc1"),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FeishuGatewayError);
      expect((err as FeishuGatewayError).code).toBe("feishu_not_configured");
      expect((err as FeishuGatewayError).status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
