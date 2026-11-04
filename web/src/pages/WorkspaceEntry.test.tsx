import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorkspaceEntry } from "./WorkspaceEntry";
import { useAuth } from "@/stores/auth";

const NON_ADMIN = {
  id: "u1", email: "u1@example.com", displayName: "U1",
  avatarUrl: null,
  isAdmin: false, isActive: true,
  chatPreference: null,
  createdAt: new Date().toISOString(),
};
const ADMIN = { ...NON_ADMIN, id: "a", email: "admin@example.com", displayName: "Admin", isAdmin: true };

// WorkspaceEntry hosts the global search bar on the happy path and the
// original empty-state cards when the user has zero accessible roles.
// Both branches are covered.
vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      listRoles: vi.fn(),
    },
    articles: {
      search: vi.fn().mockResolvedValue({ hits: [] }),
    },
    // HomeChatPanel(挂在首页右栏)首挂时拉会话列表/历史 + 专家列表(选择条数据)。
    chat: {
      listConversations: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
      getConversation: vi.fn().mockResolvedValue({ id: "c", messages: [], summary: null, summaryUpToMessageId: null, hasMoreOlder: false }),
    },
    agents: {
      list: vi.fn().mockResolvedValue({ experts: [] }),
    },
  },
}));

describe("WorkspaceEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a blank right column when the user has at least one role", async () => {
    const { api } = await import("@/lib/api");
    useAuth.setState({ user: NON_ADMIN, status: "ready", error: null });
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({
      roles: [{ id: "r1", name: "产品", description: null, color: "#a78bfa", createdAt: "", ownership: "owned", folderCount: 1 }],
    });

    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <WorkspaceEntry />
      </MemoryRouter>,
    );
    // listRoles resolves on the next tick; wait for the DelayedLoader
    // (initial null state) to vanish before asserting the blank state.
    await waitFor(() => {
      // No empty-state card and no welcome text — the page collapses to
      // nothing. The role tree lives in WorkspaceLeftRail; 文档搜索 moved to
      // the header (shell/HeaderSearch), whose input only renders when opened.
      expect(container.querySelector("h2")).toBeNull();
      expect(screen.queryByPlaceholderText("搜索文档…")).toBeNull();
    });
  });

  it("non-admin with no roles: shows contact-admin card", async () => {
    const { api } = await import("@/lib/api");
    useAuth.setState({ user: NON_ADMIN, status: "ready", error: null });
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({ roles: [] });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <WorkspaceEntry />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/联系管理员/)).toBeInTheDocument());
  });

  it("admin with no roles: shows go-create-roles card with admin links", async () => {
    const { api } = await import("@/lib/api");
    useAuth.setState({ user: ADMIN, status: "ready", error: null });
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({ roles: [] });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <WorkspaceEntry />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/还没有角色/)).toBeInTheDocument());
    expect(screen.getByText(/角色管理/)).toBeInTheDocument();
  });
});
