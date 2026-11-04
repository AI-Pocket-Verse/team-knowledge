import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminGroupQaPage } from "./AdminGroupQaPage";

const stats = vi.fn();
vi.mock("@/lib/api", () => ({ api: { admin: { groupQa: { stats: (...a: unknown[]) => stats(...a) } } } }));

beforeEach(() => {
  stats.mockReset();
  stats.mockResolvedValue({ entries: [] });
});

// 访问门控已上移到路由层 RequireAdminPage(管理员 或 该页在「页面可见性」放开);
// 页面组件本身不再自拦 isAdmin,故这里只测渲染/数据展示,不再测「非管理员被拦截」。
describe("AdminGroupQaPage", () => {
  it("空记录 → 占位文案", async () => {
    render(<MemoryRouter><AdminGroupQaPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/还没有答疑记录/)).toBeInTheDocument());
  });

  it("有记录 → 表格展示 群/问题/来源/👎数", async () => {
    stats.mockResolvedValue({
      entries: [{ chatId: "oc_1", chatName: "产品群", question: "报销怎么走", sourceTitle: "报销指南", hash: "h1", at: 1_718_000_000_000, upvotes: 3, downvotes: 2 }],
    });
    render(<MemoryRouter><AdminGroupQaPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("报销怎么走")).toBeInTheDocument());
    expect(screen.getByText("产品群")).toBeInTheDocument();
    expect(screen.getByText("《报销指南》")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // 👍
    expect(screen.getByText("2")).toBeInTheDocument(); // 👎
  });
});
