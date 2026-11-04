import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// useAuth 是 zustand 选择器 hook,mock 成「把选择器作用到假 state」。
let mockLocalUser: { id: string; displayName: string; avatarUrl: string | null; isAdmin: boolean } | null = null;
let mockSsoUser: { open_id: string; name: string; avatar_url: string | null } | null = null;

vi.mock("@/stores/auth", () => ({
  useAuth: (sel: (s: { user: typeof mockLocalUser; logout: () => void }) => unknown) =>
    sel({ user: mockLocalUser, logout: vi.fn() }),
  useIsAdmin: () => false,
}));
vi.mock("@team-knowledge/auth-client-web", () => ({
  useAuth: () => ({ user: mockSsoUser }),
}));

import { UserMenu } from "./UserMenu";

describe("UserMenu avatar", () => {
  beforeEach(() => {
    mockLocalUser = { id: "u1", displayName: "张三", avatarUrl: "https://x/a.png", isAdmin: false };
    mockSsoUser = { open_id: "o", name: "张三", avatar_url: null };
  });

  const setup = () => render(<MemoryRouter><UserMenu /></MemoryRouter>);

  it("有 avatarUrl → 触发头像渲染真实图片", () => {
    setup();
    const img = screen.getByRole("img", { name: "张三" });
    expect(img.getAttribute("src")).toBe("https://x/a.png");
  });

  it("无 avatarUrl → 回退渐变首字母", () => {
    mockLocalUser = { id: "u1", displayName: "张三", avatarUrl: null, isAdmin: false };
    setup();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("张三")).toBeTruthy();
  });
});
