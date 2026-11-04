import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AdminGithubPage } from "./AdminGithubPage";

const githubList = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { admin: { github: { list: (...a: unknown[]) => githubList(...a) } } },
  ApiError: class extends Error { status = 0 },
}));

let mockIsAdmin = true;
vi.mock("@/stores/auth", () => ({ useIsAdmin: () => mockIsAdmin }));
vi.mock("@/components/Toaster", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/Dialog", () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));

beforeEach(() => {
  mockIsAdmin = true;
  githubList.mockReset();
  githubList.mockResolvedValue({ repos: [] });
});

describe("AdminGithubPage", () => {
  it("non-admin is redirected and never lists repos", async () => {
    mockIsAdmin = false;
    const { container } = render(
      <MemoryRouter initialEntries={["/admin/github"]}>
        <Routes>
          <Route path="/admin/github" element={<AdminGithubPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent).toContain("home"));
    expect(githubList).not.toHaveBeenCalled();
  });

  it("renders the empty state + add form for an admin", async () => {
    render(<MemoryRouter><AdminGithubPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("还没有配置仓库。")).toBeInTheDocument());
    expect(screen.getByText("添加仓库")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加" })).toBeInTheDocument();
  });
});
