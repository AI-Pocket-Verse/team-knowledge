import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectToSsoLogin, ssoLoginUrl, ssoLogoutApiUrl } from "./sso";

function stubLocation(href: string) {
  const assign = vi.fn();
  const u = new URL(href);
  Object.defineProperty(window, "location", { configurable: true, value: { href, origin: u.origin, assign } });
  return assign;
}

afterEach(() => vi.restoreAllMocks());

describe("sso", () => {
  it("默认基址 /auth，登录/退出地址由同一处拼出", () => {
    expect(ssoLoginUrl()).toBe("/auth/login");
    expect(ssoLogoutApiUrl()).toBe("/auth/api/logout");
  });

  it("return_to 传与当前页面同源的绝对 URL(feishu-sso 的约定)", () => {
    const assign = stubLocation("https://kb.example.com/kb/d/abc?x=1#sec");
    redirectToSsoLogin();
    expect(assign).toHaveBeenCalledWith(`/auth/login?return_to=${encodeURIComponent("https://kb.example.com/kb/d/abc?x=1#sec")}`);
  });

  it("已在登录页时不再跳转，避免循环", () => {
    const assign = stubLocation("https://kb.example.com/auth/login?return_to=x");
    redirectToSsoLogin();
    expect(assign).not.toHaveBeenCalled();
  });
});
