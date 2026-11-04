import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/api", () => ({
  api: {
    admin: { assistantFilter: { get: vi.fn(), add: vi.fn(), remove: vi.fn() }, listRoles: vi.fn() },
    workspace: { tree: vi.fn() },
  },
  ApiError: class extends Error { status = 0 },
}));
vi.mock("@/components/Toaster", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from "@/lib/api";
import { AdminAssistantFilterPage } from "./AdminAssistantFilterPage";

describe("AdminAssistantFilterPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders roles with an exclusion checkbox + reflects already-excluded state", async () => {
    (api.admin.listRoles as Mock).mockResolvedValue({ roles: [{ id: "r1", name: "法务" }] });
    (api.admin.assistantFilter.get as Mock).mockResolvedValue({ roles: [{ id: "r1", name: "法务" }], folders: [], articles: [] });
    render(<MemoryRouter><AdminAssistantFilterPage /></MemoryRouter>);
    // 角色名会同时出现在左侧「已排除」面板与右侧树,用唯一的复选框可达名定位。
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /对 AI 隐藏角色 法务/ })).toBeInTheDocument());
    const cb = screen.getByRole("checkbox", { name: /对 AI 隐藏角色 法务/ });
    expect((cb as HTMLInputElement).checked).toBe(true); // 已排除
  });

  it("expands a role into a folder/subfolder/doc tree, showing all docs(去状态后不再仅限已发布)", async () => {
    (api.admin.listRoles as Mock).mockResolvedValue({ roles: [{ id: "r1", name: "产品" }] });
    (api.admin.assistantFilter.get as Mock).mockResolvedValue({ roles: [], folders: [], articles: [] });
    (api.workspace.tree as Mock).mockResolvedValue({
      folders: [
        {
          id: "f1", name: "PRD", parentId: null, roleId: "r1",
          articles: [
            { id: "d1", title: "已发布文档", status: "published", folderId: "f1", roleId: "r1" },
            { id: "d2", title: "草稿文档", status: "draft", folderId: "f1", roleId: "r1" },
          ],
          children: [
            { id: "f2", name: "子目录", parentId: "f1", roleId: "r1",
              articles: [{ id: "d3", title: "子目录已发布", status: "published", folderId: "f2", roleId: "r1" }],
              children: [] },
          ],
        },
      ],
      directArticles: [{ id: "d4", title: "角色直属已发布", status: "published", folderId: null, roleId: "r1" }],
    });

    render(<MemoryRouter><AdminAssistantFilterPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("产品")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /展开 产品/ }));

    await waitFor(() => expect(screen.getByText("PRD")).toBeInTheDocument());
    expect(screen.getByText("子目录")).toBeInTheDocument();
    expect(screen.getByText("已发布文档")).toBeInTheDocument();
    expect(screen.getByText("子目录已发布")).toBeInTheDocument();
    expect(screen.getByText("角色直属已发布")).toBeInTheDocument();
    // 去状态后所有文档都可作为排除对象列出(含原「草稿」)。
    expect(screen.getByText("草稿文档")).toBeInTheDocument();
  });

  it("greys out (inherits) descendants when the role is excluded", async () => {
    (api.admin.listRoles as Mock).mockResolvedValue({ roles: [{ id: "r1", name: "产品" }] });
    (api.admin.assistantFilter.get as Mock).mockResolvedValue({ roles: [{ id: "r1", name: "产品" }], folders: [], articles: [] });
    (api.workspace.tree as Mock).mockResolvedValue({
      folders: [{ id: "f1", name: "PRD", parentId: null, roleId: "r1",
        articles: [{ id: "d1", title: "文档甲", status: "published", folderId: "f1", roleId: "r1" }], children: [] }],
      directArticles: [],
    });

    render(<MemoryRouter><AdminAssistantFilterPage /></MemoryRouter>);
    // 角色名同时出现在左侧已排除面板 + 右侧树,用展开按钮的唯一可达名定位。
    await waitFor(() => expect(screen.getByRole("button", { name: /展开 产品/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /展开 产品/ }));
    await waitFor(() => expect(screen.getByText("PRD")).toBeInTheDocument());

    // 角色已排除 → 其下文件夹/文档复选框被勾选且置灰(继承,不可单独取消)。
    const folderCb = screen.getByRole("checkbox", { name: /对 AI 隐藏文件夹 PRD/ }) as HTMLInputElement;
    const docCb = screen.getByRole("checkbox", { name: /对 AI 隐藏文档 文档甲/ }) as HTMLInputElement;
    expect(folderCb.checked).toBe(true);
    expect(folderCb.disabled).toBe(true);
    expect(docCb.checked).toBe(true);
    expect(docCb.disabled).toBe(true);
  });
});
