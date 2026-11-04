import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MeetingCreatePage } from "./MeetingCreatePage";

vi.mock("@/stores/auth", () => ({
  useIsAdmin: vi.fn(() => true),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error { constructor(m: string, public status: number) { super(m); } },
  api: {
    workspace: { listRoles: vi.fn() },
    meeting: { create: vi.fn() },
  },
}));

vi.mock("@/components/Toaster", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// react-router's useNavigate — stubbed so we can assert the
// redirect to /meeting/<id> after a successful create.
const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

describe("MeetingCreatePage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-assert the admin default — `clearAllMocks` resets call
    // history but `mockReturnValue` set in a previous test persists,
    // so without this every test after a non-admin one sees admin=false.
    const { useIsAdmin } = await import("@/stores/auth");
    (useIsAdmin as ReturnType<typeof vi.fn>).mockReturnValue(true);
    // jsdom's clipboard is patchy; force a stub so the call resolves.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("renders the form for any logged-in user (no longer admin-gated)", async () => {
    const { api } = await import("@/lib/api");
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({ roles: [] });
    render(<MemoryRouter><MeetingCreatePage /></MemoryRouter>);
    expect(await screen.findByText("可见性")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/例如：V2/)).toBeInTheDocument();
    expect(screen.queryByText(/仅管理员可创建会议/)).not.toBeInTheDocument();
  });

  it("submits the chosen visibility (private)", async () => {
    const { api } = await import("@/lib/api");
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({ roles: [] });
    (api.meeting.create as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "m-x" } });
    render(<MemoryRouter><MeetingCreatePage /></MemoryRouter>);
    await screen.findByText("可见性");
    fireEvent.change(screen.getByPlaceholderText(/例如：V2/), { target: { value: "私密会" } });
    fireEvent.click(screen.getByRole("radio", { name: /私密/ }));
    fireEvent.click(screen.getByText("🔴 开始会议"));
    await waitFor(() =>
      expect(api.meeting.create).toHaveBeenCalledWith(expect.objectContaining({ title: "私密会", visibility: "private" })),
    );
  });

  it("preselects every role on first load and submits the union", async () => {
    const { api } = await import("@/lib/api");
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({
      roles: [
        { id: "r1", name: "产品", color: "violet" },
        { id: "r2", name: "服务端", color: "blue" },
      ],
    });
    (api.meeting.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { id: "m-new" },
    });

    render(<MemoryRouter><MeetingCreatePage /></MemoryRouter>);
    expect(await screen.findByText("产品")).toBeInTheDocument();
    // Default-all-selected: both checkboxes start checked so a host
    // who just wants assistant to draw on the whole corpus doesn't have
    // to click every role.
    expect((screen.getByLabelText("产品") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("服务端") as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/例如：V2/), { target: { value: "V2 评审" } });
    fireEvent.click(screen.getByText("🔴 开始会议"));

    await waitFor(() => {
      expect(api.meeting.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "V2 评审",
          allowedRoleIds: ["r1", "r2"],
        }),
      );
    });
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/meeting/m-new"));
  });

  it("submit enabled by title alone; deselecting all roles keeps it enabled (roles optional)", async () => {
    const { api } = await import("@/lib/api");
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({
      roles: [{ id: "r1", name: "产品", color: null }],
    });
    render(<MemoryRouter><MeetingCreatePage /></MemoryRouter>);
    await screen.findByText("产品");
    const button = screen.getByText("🔴 开始会议") as HTMLButtonElement;
    // Title is the only requirement now.
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/例如：V2/), { target: { value: "x" } });
    expect(button.disabled).toBe(false);
    // Roles are optional (empty = public-doc retrieval), so deselecting the
    // only role must NOT disable submit anymore.
    fireEvent.click(screen.getByLabelText("产品"));
    expect(button.disabled).toBe(false);
  });

  it("resolves role.color palette keys to actual hex on the swatch", async () => {
    const { api } = await import("@/lib/api");
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({
      // "rose" is the failure case we shipped — a palette key that
      // doesn't happen to be a valid CSS color keyword. Before the
      // fix, the dot rendered with no fill at all.
      roles: [{ id: "r1", name: "运营", color: "rose" }],
    });
    const { container } = render(<MemoryRouter><MeetingCreatePage /></MemoryRouter>);
    await screen.findByText("运营");
    const swatch = container.querySelector('span[aria-hidden="true"][class*="rounded-full"]') as HTMLElement;
    expect(swatch).not.toBeNull();
    // ROLE_PALETTE["rose"].from === "#fda4af" → rgb(253, 164, 175)
    expect(swatch.style.backgroundColor).toBe("rgb(253, 164, 175)");
  });
});
