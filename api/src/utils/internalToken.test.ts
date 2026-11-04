import { afterEach, describe, expect, it } from "vitest";
import { env } from "../env.js";
import { internalTokenOk } from "./internalToken.js";

const original = env.INTERNAL_API_TOKEN;
afterEach(() => { env.INTERNAL_API_TOKEN = original; });

describe("internalTokenOk", () => {
  it("口令一致通过；不一致、缺失、非字符串拒绝", () => {
    env.INTERNAL_API_TOKEN = "s3cret-token";
    expect(internalTokenOk("s3cret-token")).toBe(true);
    expect(internalTokenOk("s3cret-tokeX")).toBe(false);
    expect(internalTokenOk("short")).toBe(false);
    expect(internalTokenOk(undefined)).toBe(false);
    expect(internalTokenOk(["s3cret-token"])).toBe(false);
  });

  it("口令配置为空时，空请求头也不能通过", () => {
    env.INTERNAL_API_TOKEN = "";
    expect(internalTokenOk("")).toBe(false);
  });
});
