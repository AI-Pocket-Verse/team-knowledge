import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ArticleListPage } from "./ArticleListPage";
import { WorkspaceFolderProvider } from "@/lib/workspaceFolderContext";

// ArticleListPage now delegates to ArticleTimeFeed which fetches via
// api.feed({ folderId }), not api.articles.list. The header still
// shows folder info + canEdit affordance / readonly banner.
vi.mock("@/lib/api", () => {
  const baseRow = {
    folderId: "m1", folderName: "需求池",
    roleId: "r1", roleName: "产品", roleColor: "#a78bfa",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissions: { canView: true, canEdit: true, canBookmark: true, canCite: true, canExport: true, isReadOnly: false },
  };
  const folderBase = {
    description: null, roleId: "r1", visibility: "public", templateType: "article-list",
    createdById: "u1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    permissions: { canView: true, canEdit: true, isReadOnly: false },
  };
  return {
    api: {
      feed: vi.fn().mockResolvedValue({
        articles: [
          { ...baseRow, id: "a1", title: "需求 v1", status: "draft" },
          { ...baseRow, id: "a2", title: "需求 v2", status: "published" },
        ],
      }),
      // The folder page now also reads the role tree to list subfolders above
      // the doc feed. m1 has one subfolder ("子需求").
      workspace: {
        tree: vi.fn().mockResolvedValue({
          folders: [
            {
              ...folderBase, id: "m1", name: "需求池", parentId: null, articles: [],
              children: [
                { ...folderBase, id: "sub1", name: "子需求", parentId: "m1", articles: [{ id: "x" }], children: [] },
              ],
            },
          ],
          directArticles: [],
        }),
      },
    },
  };
});

const mod = {
  id: "m1", name: "需求池", description: null, roleId: "r1", parentId: null, visibility: "public" as const,
  templateType: "article-list", createdById: "u1",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  permissions: { canView: true, canEdit: true, isReadOnly: false },
  role: { id: "r1", name: "产品", description: null, color: "#a78bfa", createdAt: new Date().toISOString() },
  createdBy: { id: "u1", displayName: "Wenxuan" },
};

function renderPage(canEdit = true) {
  const permissions = canEdit
    ? { canView: true, canEdit: true, isReadOnly: false }
    : { canView: true, canEdit: false, isReadOnly: true };
  return render(
    <MemoryRouter initialEntries={["/f/m1"]}>
      <WorkspaceFolderProvider value={{ folder: mod, permissions, refetch: async () => {} }}>
        <Routes>
          <Route path="/f/:folderId" element={<ArticleListPage />} />
        </Routes>
      </WorkspaceFolderProvider>
    </MemoryRouter>,
  );
}

describe("ArticleListPage", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("renders feed rows from api.feed with folder filter", async () => {
    renderPage();
    expect(await screen.findByText("需求 v1")).toBeInTheDocument();
    expect(await screen.findByText("需求 v2")).toBeInTheDocument();
    // No bulk-edit affordances; rows are <a> not table cells.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
  });

  it("hides 新建文档 button for read-only viewer and shows readonly banner", async () => {
    renderPage(false);
    await screen.findByText("需求 v1");
    expect(screen.queryByRole("button", { name: /新建文档/ })).not.toBeInTheDocument();
    expect(screen.getByText(/只读模式/)).toBeInTheDocument();
  });

  it("lists subfolders above the doc feed", async () => {
    renderPage();
    // The subfolder strip renders from the role tree, even though the doc feed
    // is what api.feed returns.
    expect(await screen.findByText("子需求")).toBeInTheDocument();
    expect(screen.getByText("子目录")).toBeInTheDocument();
  });
});
