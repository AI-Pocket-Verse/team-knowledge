import { describe, expect, it } from "vitest";
import { volcAuthHeaders, maskSecret, isMaskedSecret } from "./volcAuth.js";

describe("volcAuthHeaders", () => {
  it("配置了 API Key → 只发 X-Api-Key + Resource-Id(新版控制台)", () => {
    expect(volcAuthHeaders({ apiKey: "k", appId: "a", accessToken: "t" }, "r")).toEqual({
      "X-Api-Key": "k", "X-Api-Resource-Id": "r",
    });
  });
  it("没有 API Key → 旧版 App-Key + Access-Key", () => {
    expect(volcAuthHeaders({ appId: "a", accessToken: "t" }, "r")).toEqual({
      "X-Api-App-Key": "a", "X-Api-Access-Key": "t", "X-Api-Resource-Id": "r",
    });
  });
  it("凭据不全时抛错", () => {
    expect(() => volcAuthHeaders({ appId: "a" }, "r")).toThrow();
  });
});

describe("maskSecret", () => {
  it("长密钥只露末 4 位，短密钥全遮", () => {
    expect(maskSecret("supersecrettoken1234")).toBe("****1234");
    expect(maskSecret("short")).toBe("****");
    expect(maskSecret(undefined)).toBeNull();
    expect(isMaskedSecret("****1234")).toBe(true);
    expect(isMaskedSecret("real")).toBe(false);
  });
});
