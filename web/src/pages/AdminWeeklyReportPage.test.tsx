import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminWeeklyReportPage } from "./AdminWeeklyReportPage";

const list = vi.fn();
vi.mock("@/lib/api", () => ({ api: { admin: { weeklyReport: { list: (...a: unknown[]) => list(...a), generate: vi.fn() } } } }));
const access = { isAdmin: false };
vi.mock("@/lib/adminAccess", () => ({ useAdminAccess: () => ({ ...access, openPages: ["weekly-report"], canEnter: true, loading: false }) }));

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ reports: [] });
});

// 周报页可放开给成员只读,但生成 / 刷新接口仅管理员可用。
describe("AdminWeeklyReportPage", () => {
  it("成员:不显示生成按钮,空状态不引导去点按钮", async () => {
    access.isAdmin = false;
    render(<MemoryRouter><AdminWeeklyReportPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/每周一会自动生成/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /生成\/刷新本周周报/ })).toBeNull();
  });

  it("管理员:显示生成按钮", async () => {
    access.isAdmin = true;
    render(<MemoryRouter><AdminWeeklyReportPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("button", { name: /生成\/刷新本周周报/ })).toBeInTheDocument());
  });
});
