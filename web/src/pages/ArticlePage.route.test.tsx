import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";

vi.mock("@/components/article/MilkdownEditor", () => ({
  MilkdownEditor: ({ initialMarkdown }: { initialMarkdown: string }) => <div data-testid="editor">{initialMarkdown}</div>,
}));
vi.mock("@/components/Toaster", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (o) => {
  const actual = await o<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      articles: {
        get: vi.fn(), update: vi.fn(), acquireEditLock: vi.fn(),
        releaseEditLock: vi.fn().mockResolvedValue(undefined),
        exportUrl: (id: string) => `/x/${id}`,
        search: vi.fn().mockResolvedValue({ hits: [] }),
      },
      notifications: { readByArticle: vi.fn().mockResolvedValue({ unread: 0 }) },
      comments: { list: vi.fn().mockResolvedValue({ comments: [] }), add: vi.fn(), remove: vi.fn() },
    },
  };
});
import { api, ApiError } from "@/lib/api";
import { ArticlePage } from "./ArticlePage";

const article = {
  id: "ok1", title: "合法文档", contentMarkdown: "正文内容",
  roleId: "r1", folderId: null, role: { id: "r1", name: "角色" }, folder: null,
  createdBy: { id: "u9", displayName: "作者" }, createdById: "u9",
  updatedAt: "2026-06-18T00:00:00.000Z", createdAt: "2026-06-18T00:00:00.000Z",
  sortOrder: 0, inboundRefs: [], versionsCount: 0,
  isLiked: false, likeCount: 0, isBookmarked: false, bookmarkCount: 0, commentCount: 0, editing: null,
  permissions: { canView: true, canEdit: false, canBookmark: true, canCite: true, canExport: true, canManageEditors: false, isReadOnly: true },
};

let go: (to: string) => void = () => {};
function Nav() {
  const nav = useNavigate();
  go = (to) => nav(to);
  return null;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("ArticlePage 切换路由参数", () => {
  it("先 404 再切到合法文档,显示正文而不是停在错误页", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "bad") throw new ApiError("not found", 404);
      return { article };
    });
    render(
      <MemoryRouter initialEntries={["/d/bad"]}>
        <Nav />
        <Routes><Route path="/d/:docId" element={<ArticlePage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("该文档不存在或无权访问。")).toBeTruthy();
    act(() => go("/d/ok1"));
    expect(await screen.findByTestId("editor")).toBeTruthy();
    expect(screen.queryByText("该文档不存在或无权访问。")).toBeNull();
  });
});
