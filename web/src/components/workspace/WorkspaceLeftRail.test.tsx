import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceLeftRail } from "./WorkspaceLeftRail";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { api } from "@/lib/api";

// Rail is a Role→Folder tree. Every role auto-expands on first load
// (default-open). Manual chevron clicks toggle a role's subtree
// shut without navigating. Active state uses macaron-mint surfaces
// instead of pure white so it reads against the surface-tinted rail.
vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      listRoles: vi.fn(async () => ({
        roles: [
          { id: "r1", name: "产品", color: "violet", ownership: "owned" },
          { id: "r2", name: "运营", color: "amber",  ownership: "readonly" },
        ],
      })),
      tree: vi.fn(async (rid: string) => ({
        folders: rid === "r1"
          ? [
              { id: "m1", name: "PRD", roleId: "r1", parentId: null, articles: [], children: [], permissions: { canEdit: false } },
              { id: "m2", name: "需求池", roleId: "r1", parentId: null, articles: [], children: [], permissions: { canEdit: false } },
            ]
          : [
              { id: "m3", name: "活动", roleId: "r2", parentId: null, articles: [], children: [], permissions: { canEdit: false } },
            ],
        directArticles: [],
      })),
    },
  },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/f/:folderId" element={<WorkspaceLeftRail />} />
        <Route path="/r/:roleId" element={<WorkspaceLeftRail />} />
        <Route path="/*" element={<WorkspaceLeftRail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // The refresh-signal store is a module singleton — reset it so a
  // signal fired in one test doesn't leak into the next mount.
  useWorkspaceTree.setState({ nonce: 0, roleId: null });
});

describe("WorkspaceLeftRail (tree)", () => {
  it("default-expands every role on first load (all folders visible)", async () => {
    renderAt("/f/m1");
    // Both roles' folders visible without any chevron clicks.
    await waitFor(() => expect(screen.getByRole("link", { name: /^产品/ })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /^运营/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PRD" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "需求池" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "活动" })).toBeInTheDocument();
  });

  // (已删除)「未发布草稿小圆点」用例:去状态后不再有草稿/未发布标识。

  it("clicking a role's chevron collapses that role's folders without navigating", async () => {
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("link", { name: "活动" })).toBeInTheDocument());

    // Find the 运营 row's chevron (currently in "收起" state
    // since the rail default-expands).
    const operRow = screen.getByRole("link", { name: /^运营/ }).parentElement!;
    const chevron = operRow.querySelector('button[aria-label="收起"]')!;
    fireEvent.click(chevron);
    await waitFor(() => expect(screen.queryByRole("link", { name: "活动" })).not.toBeInTheDocument());
    // Other role's folders remain visible.
    expect(screen.getByRole("link", { name: "PRD" })).toBeInTheDocument();
  });

  it("active folder row uses the Feishu accent-soft highlight surface", async () => {
    renderAt("/f/m2");
    await waitFor(() => expect(screen.getByRole("link", { name: /需求池/ })).toBeInTheDocument());
    const row = screen.getByRole("link", { name: /需求池/ });
    // 飞书改版后选中态:浅蓝 bg-accent-soft 底 + 主蓝 text-primary 文字 + semibold。
    // Hover 也用 semibold,故 active 与 hover 的区分落在底色(accent-soft)与
    // 文字色(primary),而非字重。
    expect(row.className).toMatch(/bg-accent-soft/);
    expect(row.className).toMatch(/text-primary/);
    expect(row.className).toMatch(/font-semibold/);
    // Left accent bar was dropped per UX feedback — the tint+color
    // pair is enough to read as "selected" without an extra rule.
    expect(row.className).not.toMatch(/before:bg-primary/);
  });

  it("collapse toggle persists to localStorage", async () => {
    renderAt("/f/m1");
    await waitFor(() => expect(screen.getByRole("link", { name: /^产品/ })).toBeInTheDocument());
    const toggle = screen.getByRole("button", { name: /收起侧边栏|展开侧边栏/ });
    fireEvent.click(toggle);
    expect(window.localStorage.getItem("tm.ws.leftRail.collapsed")).toBe("1");
  });

  it("when sidebar collapsed, role rows become title-only color chips; folders don't render", async () => {
    window.localStorage.setItem("tm.ws.leftRail.collapsed", "1");
    renderAt("/f/m1");
    await waitFor(() => expect(screen.getByTitle("产品")).toBeInTheDocument());
    expect(screen.getByTitle("运营")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "PRD" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "需求池" })).not.toBeInTheDocument();
  });

  it("refetches a role's subtree when an external refresh signal fires", async () => {
    // Simulates the meeting summary "保存到知识库" panel: it saves a
    // draft into a role, then nudges the rail via the shared store.
    renderAt("/meeting/abc"); // routed page outside the rail's own dialogs
    await waitFor(() => expect(screen.getByRole("link", { name: /^产品/ })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "会议纪要草稿" })).not.toBeInTheDocument();

    // The server now has the freshly-saved draft under r1.
    vi.mocked(api.workspace.tree).mockImplementation(async (rid: string) => ({
      folders: [],
      directArticles: rid === "r1"
        ? [{ id: "d99", title: "会议纪要草稿", roleId: "r1", folderId: null, status: "draft", permissions: { canEdit: true } } as never]
        : [],
    }));

    act(() => { useWorkspaceTree.getState().requestRoleRefresh("r1"); });

    await waitFor(() => expect(screen.getByRole("link", { name: "会议纪要草稿" })).toBeInTheDocument());
  });

  it("renders a subfolder nested under its top-level folder once that folder is expanded", async () => {
    vi.mocked(api.workspace.tree).mockImplementation(async (rid: string) => ({
      folders: rid === "r1"
        ? [{
            id: "m1", name: "PRD", roleId: "r1", parentId: null, articles: [], permissions: { canEdit: false },
            children: [{ id: "m1a", name: "历史版本", roleId: "r1", parentId: "m1", articles: [], children: [], permissions: { canEdit: false } }],
          } as never]
        : [],
      directArticles: [],
    }));
    renderAt("/r/r1");
    await waitFor(() => expect(screen.getByRole("link", { name: "PRD" })).toBeInTheDocument());
    // Subfolder is hidden until the parent folder is expanded (folders are
    // collapsed by default; only roles auto-expand).
    expect(screen.queryByRole("link", { name: "历史版本" })).not.toBeInTheDocument();
    const prdRow = screen.getByRole("link", { name: "PRD" }).parentElement!;
    fireEvent.click(prdRow.querySelector('button[aria-label="展开"]')!);
    await waitFor(() => expect(screen.getByRole("link", { name: "历史版本" })).toBeInTheDocument());
  });

  it("right-click on a manageable folder opens a context menu (new + rename/delete)", async () => {
    vi.mocked(api.workspace.tree).mockImplementation(async (rid: string) => ({
      folders: rid === "r1"
        ? [{ id: "m1", name: "PRD", roleId: "r1", parentId: null, articles: [], children: [], permissions: { canEdit: true } } as never]
        : [],
      directArticles: [],
    }));
    renderAt("/r/r1");
    const prd = await screen.findByRole("link", { name: "PRD" });
    fireEvent.contextMenu(prd);
    expect(await screen.findByRole("menuitem", { name: "新建目录" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument();
  });

  it("right-click on a doc opens 重命名/移动/删除", async () => {
    vi.mocked(api.workspace.tree).mockImplementation(async (rid: string) => ({
      folders: [],
      directArticles: rid === "r1"
        ? [{ id: "d1", title: "文档A", roleId: "r1", folderId: null, status: "draft", permissions: { canEdit: true, canView: true } } as never]
        : [],
    }));
    renderAt("/r/r1");
    const doc = await screen.findByRole("link", { name: "文档A" });
    fireEvent.contextMenu(doc);
    expect(await screen.findByRole("menuitem", { name: "移动" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument();
  });
});
