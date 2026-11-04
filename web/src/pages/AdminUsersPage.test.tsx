import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminUsersPage } from "./AdminUsersPage";
import { useAuth } from "@/stores/auth";
import { setCurrentLang } from "@/i18n/lang";

const me = {
  id: "admin-id",
  email: "admin@example.com",
  displayName: "Admin",
  avatarUrl: null,
  isAdmin: true,
  isActive: true,
  chatPreference: null,
  createdAt: new Date().toISOString(),
};

vi.mock("@/lib/api", () => ({
  api: {
    admin: {
      listUsers: vi.fn().mockResolvedValue({
        users: [
          {
            id: "admin-id",
            email: "admin@example.com",
            displayName: "Admin",
            avatarUrl: null,
            isAdmin: true,
            isActive: true,
            createdAt: new Date().toISOString(),
            roles: [],
          },
          {
            id: "u1",
            email: "u1@example.com",
            displayName: "User One",
            avatarUrl: null,
            isAdmin: false,
            isActive: true,
            createdAt: new Date().toISOString(),
            roles: [{ id: "r1", name: "产品", description: null, color: "violet", createdAt: new Date().toISOString() }],
          },
        ],
      }),
      listRoles: vi.fn().mockResolvedValue({
        roles: [{ id: "r1", name: "产品", description: null, color: "violet", createdAt: new Date().toISOString(), memberCount: 1 }],
      }),
      updateUser: vi.fn().mockResolvedValue({
        user: { id: "u1", email: "u1@example.com", displayName: "User One", avatarUrl: null, isAdmin: false, isActive: true, createdAt: new Date().toISOString(), roles: [] },
      }),
      deleteUser: vi.fn(),
    },
  },
}));

describe("AdminUsersPage", () => {
  beforeEach(() => {
    useAuth.setState({ user: me, status: "ready", error: null });
  });

  it("renders user rows from the API", async () => {
    render(<MemoryRouter><AdminUsersPage /></MemoryRouter>);
    expect(await screen.findByText("Admin")).toBeInTheDocument();
    expect(await screen.findByText("User One")).toBeInTheDocument();
    expect(await screen.findByText("产品")).toBeInTheDocument();
  });

  it("renders English headers and tooltips when the language is en", async () => {
    setCurrentLang("en");
    try {
      render(<MemoryRouter><AdminUsersPage /></MemoryRouter>);
      await screen.findByText("Admin");
      expect(screen.getByText("Created")).toBeInTheDocument();
      expect(screen.getByText("Users appear here automatically after their first sign-in. Assign roles and permissions here.")).toBeInTheDocument();
      const adminRow = screen.getByText("Admin").closest("tr")!;
      const deleteBtn = Array.from(adminRow.querySelectorAll("button")).find((b) => b.textContent === "Delete")!;
      expect(deleteBtn).toHaveAttribute("title", "You can't delete yourself");
    } finally {
      setCurrentLang("zh");
    }
  });

  it("shows the SSO email column (no create-user button)", async () => {
    render(<MemoryRouter><AdminUsersPage /></MemoryRouter>);
    await screen.findByText("Admin");
    expect(screen.getByText("u1@example.com")).toBeInTheDocument();
    // Users self-provision via SSO — there is no "+ 新建用户" button.
    expect(screen.queryByRole("button", { name: /新建用户/ })).not.toBeInTheDocument();
  });

  it("disables 删除 on the self row", async () => {
    render(<MemoryRouter><AdminUsersPage /></MemoryRouter>);
    await screen.findByText("Admin");
    const adminRow = screen.getByText("Admin").closest("tr")!;
    const deleteBtn = Array.from(adminRow.querySelectorAll("button")).find((b) => b.textContent === "删除")!;
    expect(deleteBtn).toBeDisabled();
  });

  it("edits a user's flags/roles via the edit dialog; displayName is read-only", async () => {
    const { api } = await import("@/lib/api");
    render(<MemoryRouter><AdminUsersPage /></MemoryRouter>);
    await screen.findByText("User One");
    const row = screen.getByText("User One").closest("tr")!;
    const editBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "编辑")!;
    fireEvent.click(editBtn);
    // 显示名 is shown read-only — there is NO editable input bound to it.
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
    // Edit a real field (toggle 启用) and save.
    fireEvent.click(screen.getByLabelText("启用"));
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    await waitFor(() => {
      expect(api.admin.updateUser).toHaveBeenCalledWith(
        "u1",
        expect.not.objectContaining({ displayName: expect.anything() }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("编辑用户")).not.toBeInTheDocument();
    });
  });
});
