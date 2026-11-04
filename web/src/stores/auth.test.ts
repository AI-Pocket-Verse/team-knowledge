import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAuth, useIsAdmin } from "./auth";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn(),
    logout: vi.fn(),
  },
}));

const { api } = await import("@/lib/api");

// Stub window.location.assign so logout's SSO redirect doesn't throw in jsdom.
const assignSpy = vi.fn();
beforeEach(() => {
  useAuth.setState({ user: null, status: "idle", error: null });
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign: assignSpy, href: "http://localhost/" },
  });
});

const SSO_USER = {
  id: "1",
  email: "a@example.com",
  displayName: "A",
  avatarUrl: null,
  isAdmin: true,
  isActive: true,
  chatPreference: null,
  createdAt: "",
};

describe("auth store", () => {
  it("bootstrap sets the local user when /me returns a user", async () => {
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ user: SSO_USER });
    await useAuth.getState().bootstrap();
    expect(useAuth.getState().user?.displayName).toBe("A");
    expect(useAuth.getState().status).toBe("ready");
  });

  it("bootstrap sets user=null when /me returns null", async () => {
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ user: null });
    await useAuth.getState().bootstrap();
    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().status).toBe("ready");
  });

  it("logout clears the local user, calls the logout API, and redirects to the SSO login landing", async () => {
    useAuth.setState({ user: { ...SSO_USER } });
    (api.logout as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await useAuth.getState().logout();
    expect(useAuth.getState().user).toBeNull();
    // api.logout() performs the actual sso_session-clearing POST...
    expect(api.logout).toHaveBeenCalledOnce();
    // ...and the browser is sent to the branded SSO *login* page (a real GET
    // page), NOT the POST-only /api/logout endpoint (which would 404 on GET).
    expect(assignSpy).toHaveBeenCalledWith(expect.stringContaining("/auth/login"));
    expect(assignSpy).not.toHaveBeenCalledWith(expect.stringContaining("/api/logout"));
  });
});

describe("admin selector", () => {
  beforeEach(() => {
    useAuth.setState({ user: null, status: "ready", error: null });
  });

  it("useIsAdmin is false when no user", () => {
    const { result } = renderHook(() => useIsAdmin());
    expect(result.current).toBe(false);
  });

  it("useIsAdmin reflects user.isAdmin", () => {
    useAuth.setState({ user: { ...SSO_USER, isAdmin: true } });
    const { result } = renderHook(() => useIsAdmin());
    expect(result.current).toBe(true);
  });
});
