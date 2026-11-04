import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "./api";

// Mock the auth store lazy import
vi.mock("../stores/auth", () => ({
  useAuth: {
    getState: () => ({ setUser: vi.fn() }),
  },
}));

const assignSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      origin: "http://localhost",
      href: "http://localhost/some-page",
      pathname: "/some-page",
      search: "",
      assign: assignSpy,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api request() — 401 handling", () => {
  it("redirects to the SSO login (/auth/login?return_to=...) on 401", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "Unauthorized" }),
    } as unknown as Response);

    // Dynamically import api after fetch is mocked
    const { api } = await import("./api");

    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(assignSpy).toHaveBeenCalledWith(
      expect.stringContaining("/auth/login?return_to=")
    );
  });

  it("throws ApiError with status 401 on 401 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "session expired" }),
    } as unknown as Response);

    const { api } = await import("./api");

    let err: ApiError | null = null;
    try { await api.me(); } catch (e) { err = e as ApiError; }
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(401);
  });

  it("does NOT redirect if already on the SSO login URL", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        origin: "http://localhost",
        href: "http://localhost/auth/login?return_to=%2F",
        pathname: "/auth/login",
        search: "?return_to=%2F",
        assign: assignSpy,
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as unknown as Response);

    const { api } = await import("./api");
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
