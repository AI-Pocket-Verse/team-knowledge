import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminRolesPage } from "./AdminRolesPage";
import { useAuth } from "@/stores/auth";

vi.mock("@/lib/api", () => {
  const ROLE = {
    id: "r1",
    name: "产品",
    description: "产品需求",
    color: "violet",
    createdAt: new Date().toISOString(),
    memberCount: 3,
  };
  return {
    api: {
      admin: {
        listRoles: vi.fn().mockResolvedValue({ roles: [ROLE] }),
        createRole: vi.fn().mockResolvedValue({ role: { ...ROLE, id: "r2", name: "设计", color: "pink", memberCount: 0 } }),
        updateRole: vi.fn(),
        deleteRole: vi.fn().mockResolvedValue(undefined),
      },
      // The per-row Skill button mounts a status poll on render.
      roleSkill: {
        get: vi.fn().mockResolvedValue({ status: "empty", content: "", name: "", description: "", generatedAt: null, stale: true, docCount: 0, currentDocCount: 0, truncated: 0, error: null }),
        regenerate: vi.fn().mockResolvedValue({ ok: true, status: "stale" }),
        rawUrl: vi.fn().mockReturnValue("/kb/api/roles/r1/skill/raw"),
      },
    },
  };
});

describe("AdminRolesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Page redirects non-admins to "/" (workspace home) via a Navigate
    // guard, so tests must seed an admin user before render.
    useAuth.setState({
      user: { id: "admin", email: "admin@example.com", displayName: "Admin", avatarUrl: null, isAdmin: true, isActive: true, chatPreference: null, createdAt: new Date().toISOString() },
      status: "ready",
    });
  });

  it("renders a role row with member count", async () => {
    render(<MemoryRouter><AdminRolesPage /></MemoryRouter>);
    expect(await screen.findByText("产品")).toBeInTheDocument();
    expect(await screen.findByText("3")).toBeInTheDocument();
  });

  it("posts the chosen palette key when creating a role", async () => {
    const { api } = await import("@/lib/api");
    render(<MemoryRouter><AdminRolesPage /></MemoryRouter>);
    await screen.findByText("产品");
    fireEvent.click(screen.getAllByRole("button", { name: /新建角色/ })[0]);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "设计" } });
    fireEvent.click(screen.getByRole("button", { name: "粉" }));
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    await waitFor(() => {
      expect(api.admin.createRole).toHaveBeenCalledWith({
        name: "设计",
        description: null,
        color: "pink",
      });
    });
  });

  it("shows live memberCount in delete dialog", async () => {
    render(<MemoryRouter><AdminRolesPage /></MemoryRouter>);
    await screen.findByText("产品");
    const row = screen.getByText("产品").closest("tr")!;
    fireEvent.click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "删除")!);
    expect(
      await screen.findByText((_, el) => el?.tagName === "P" && !!el.textContent?.includes("3") && !!el.textContent?.includes("名成员")),
    ).toBeInTheDocument();
  });
});
