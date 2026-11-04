import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Drive the per-render admin flag so we can assert the "聚合公开、个人明细仅管理员"
// split from the client side. vi.hoisted holds the mutable state the mock reads.
const auth = vi.hoisted(() => ({ isAdmin: false }));
vi.mock("@/stores/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/auth")>();
  return { ...actual, useIsAdmin: () => auth.isAdmin };
});

// Mock data lives INSIDE the factory — vi.mock is hoisted above module-scope
// consts, so referencing outer variables here throws "cannot access before init".
vi.mock("@/lib/api", () => {
  const dashboard = {
    days: 14,
    dayLabels: Array.from({ length: 14 }, (_, i) => `06-${String(i + 1).padStart(2, "0")}`),
    overview: { totalUsers: 2, activeToday: 1, active7d: 2, newUsers7d: 1, docs: 4, comments: 1, meetings: 0, chatMessages: 0 },
    // A real per-user row so the admin path renders the table (and its PII);
    // the non-admin path must hide it even though the data is present.
    users: [
      { id: "u1", displayName: "User One", email: "u1@example.com", avatarUrl: null, isAdmin: false, isActive: true, roles: ["产品"], createdAt: "2026-06-01T00:00:00.000Z", lastSeenAt: "2026-06-07T00:00:00.000Z", opsToday: 2, ops7d: 5, daily: new Array(14).fill(0) },
    ],
  };
  const analytics = {
    days: 14,
    trends: { dayLabels: ["06-05", "06-06", "06-07"], docCreate: [1, 2, 3], docEdit: [0, 0, 0], comment: [0, 0, 1], like: [1, 0, 0], bookmark: [0, 0, 0], upload: [0, 0, 0], chat: [0, 0, 0], meeting: [0, 0, 0], activeUsers: [1, 2, 2] },
    composition: { byRole: [{ roleId: "r1", roleName: "产品", count: 3 }], byInteraction: [{ key: "like", count: 1 }, { key: "comment", count: 1 }, { key: "bookmark", count: 0 }], byUpload: [{ key: "image", count: 1 }, { key: "document", count: 0 }, { key: "other", count: 0 }] },
    rankings: { hotDocs: [{ articleId: "a1", title: "A1", score: 5, viewers: 5, likes: 0, comments: 0, bookmarks: 0 }], topContributors: [{ userId: "u1", userName: "User One", ops: 3, contribution: 9, breakdown: [{ type: "doc_create", count: 3 }], received: 0 }], docsByRole: [{ roleId: "r1", roleName: "产品", count: 3 }], skillStatus: [{ status: "fresh", count: 1 }] },
  };
  return {
    api: {
      admin: {
        dashboard: vi.fn().mockResolvedValue(dashboard),
        analytics: vi.fn().mockResolvedValue(analytics),
        activity: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasMore: false }),
        dashboardStreamUrl: vi.fn().mockReturnValue("/api/admin/dashboard/stream"),
      },
    },
  };
});

// Don't open a real SSE stream in jsdom (the hook is covered by its own test).
vi.mock("@/components/dashboard/useDashboardStream", () => ({ useDashboardStream: () => {} }));

import { DashboardPage } from "./DashboardPage";

describe("DashboardPage", () => {
  beforeEach(() => { auth.isAdmin = false; });

  it("renders overview header + the aggregate chart sections (for everyone)", async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByText("数据看板")).toBeInTheDocument();
    expect(await screen.findByText("内容与互动趋势")).toBeInTheDocument();
    expect(await screen.findByText("各角色文档占比")).toBeInTheDocument();
    expect(await screen.findByText("热门文档")).toBeInTheDocument();
    expect(await screen.findByText("角色 Skill 状态")).toBeInTheDocument();
    expect(await screen.findByText("实时动态")).toBeInTheDocument();
    expect(await screen.findByText("知识库待处理")).toBeInTheDocument();
  });

  it("hides the per-user 用户活跃 table (and its PII) from a non-admin", async () => {
    auth.isAdmin = false;
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    // Wait for the aggregate to load, then assert the admin-only table is absent.
    expect(await screen.findByText("实时动态")).toBeInTheDocument();
    expect(screen.queryByText("每日操作")).not.toBeInTheDocument();
    expect(screen.queryByText("u1@example.com")).not.toBeInTheDocument();
  });

  it("shows the per-user 用户活跃 table to an admin", async () => {
    auth.isAdmin = true;
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByText("每日操作")).toBeInTheDocument();
    expect(await screen.findByText("u1@example.com")).toBeInTheDocument();
  });
});
