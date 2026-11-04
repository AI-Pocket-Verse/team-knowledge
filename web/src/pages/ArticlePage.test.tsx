import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";

// 编辑器替身:既「快照 initialMarkdown(mount-once,忠实于真实 Crepe)」以守护
// 「切文档不串内容」,又把 readOnly 暴露成 data 属性以断言只读/可写切换。
vi.mock("@/components/article/MilkdownEditor", async () => {
  const { useState } = await vi.importActual<typeof import("react")>("react");
  return {
    MilkdownEditor: ({ initialMarkdown, readOnly }: { initialMarkdown: string; readOnly?: boolean }) => {
      const [snapshot] = useState(initialMarkdown);
      return <div data-testid="editor" data-readonly={String(!!readOnly)}>{snapshot}</div>;
    },
  };
});
vi.mock("@/components/Toaster", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/lib/api", async (o) => {
  const actual = await o<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      articles: {
        get: vi.fn(),
        update: vi.fn(),
        acquireEditLock: vi.fn(),
        releaseEditLock: vi.fn().mockResolvedValue(undefined),
        exportUrl: (id: string) => `/x/${id}`,
        search: vi.fn().mockResolvedValue({ hits: [] }),
      },
      bookmarks: { add: vi.fn().mockResolvedValue({ isBookmarked: true, bookmarkCount: 1 }), remove: vi.fn().mockResolvedValue({ isBookmarked: false, bookmarkCount: 0 }) },
      likes: { add: vi.fn().mockResolvedValue({ isLiked: true, likeCount: 1 }), remove: vi.fn().mockResolvedValue({ isLiked: false, likeCount: 0 }) },
      notifications: { readByArticle: vi.fn().mockResolvedValue({ unread: 0 }) },
      comments: { list: vi.fn().mockResolvedValue({ comments: [] }), add: vi.fn(), remove: vi.fn() },
      uploads: { image: vi.fn(), file: vi.fn() },
    },
  };
});
import { api, ApiError, EditLockConflictError } from "@/lib/api";
import { ArticlePage } from "./ArticlePage";

const article = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "a1", title: "Hello", contentMarkdown: "body content",
  roleId: "r1", folderId: null, role: { id: "r1", name: "角色" }, folder: null,
  createdBy: { id: "u9", displayName: "作者" }, createdById: "u9",
  updatedAt: "2026-06-18T00:00:00.000Z", createdAt: "2026-06-18T00:00:00.000Z",
  sortOrder: 0, inboundRefs: [{ id: "ref1", title: "Citing", folderId: null, roleId: "r1" }], versionsCount: 0,
  isLiked: false, likeCount: 0, isBookmarked: false, bookmarkCount: 0, commentCount: 0, editing: null,
  permissions: { canView: true, canEdit: true, canBookmark: true, canCite: true, canExport: true, canManageEditors: false, isReadOnly: false },
  ...over,
});

function renderAt(entry = "/d/a1", extra?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      {extra}
      <Routes><Route path="/d/:docId" element={<ArticlePage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe("ArticlePage 看即可改", () => {
  it("渲染标题/正文/被引用", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockResolvedValue({ article: article() });
    renderAt();
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(await screen.findByTestId("editor")).toHaveTextContent("body content");
    expect(await screen.findByText(/被引用/)).toBeInTheDocument();
    expect(await screen.findByText("Citing")).toBeInTheDocument();
  });

  it("切换文档后展示新文档正文(编辑器不串旧内容)", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      Promise.resolve({ article: article({ id, title: id === "A" ? "Doc A" : "Doc B", contentMarkdown: id === "A" ? "AAA-body" : "BBB-body", inboundRefs: [] }) }));
    function GoTo({ to }: { to: string }) { const nav = useNavigate(); return <button onClick={() => nav(to)}>go</button>; }
    renderAt("/d/B", <GoTo to="/d/A" />);
    expect(await screen.findByTestId("editor")).toHaveTextContent("BBB-body");
    fireEvent.click(screen.getByText("go"));
    expect(await screen.findByText("Doc A")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("editor")).toHaveTextContent("AAA-body"));
    expect(screen.getByTestId("editor")).not.toHaveTextContent("BBB-body");
  });

  it("403 → 友好提示", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError("请求失败", 403));
    renderAt();
    expect(await screen.findByText(/该文档不存在或无权访问/)).toBeInTheDocument();
  });

  it("操作栏 收藏/点赞 调用对应 API", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockResolvedValue({ article: article() });
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "收藏" }));
    await waitFor(() => expect(api.bookmarks.add).toHaveBeenCalledWith("a1"));
    fireEvent.click(await screen.findByRole("button", { name: "点赞" }));
    await waitFor(() => expect(api.likes.add).toHaveBeenCalledWith("a1"));
  });

  it("无编辑权限 → 编辑器只读,点编辑区不抢锁", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockResolvedValue({ article: article({ permissions: { canView: true, canEdit: false, canBookmark: true, canCite: true, canExport: true, canManageEditors: false, isReadOnly: true } }) });
    renderAt();
    const ed = await screen.findByTestId("editor");
    expect(ed.getAttribute("data-readonly")).toBe("true");
    fireEvent.pointerDown(screen.getByTestId("editor-shell"));
    await Promise.resolve();
    expect(api.articles.acquireEditLock).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true");
  });

  it("有编辑权限 → 编辑器一打开即可写;点正文(懒锁)抢锁", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockResolvedValue({ article: article() });
    (api.articles.acquireEditLock as ReturnType<typeof vi.fn>).mockResolvedValue({ lock: { mine: true } });
    renderAt();
    const ed = await screen.findByTestId("editor");
    expect(ed.getAttribute("data-readonly")).toBe("false"); // 看即可改:一打开即可写
    fireEvent.pointerDown(screen.getByTestId("editor-shell"));
    await waitFor(() => expect(api.articles.acquireEditLock).toHaveBeenCalledWith("a1"));
    expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("false"); // 抢锁成功仍可写
  });

  it("他人持锁(409)→ 切回只读", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockResolvedValue({ article: article() });
    (api.articles.acquireEditLock as ReturnType<typeof vi.fn>).mockRejectedValue(
      new EditLockConflictError("被占用", { userId: "u2", userName: "张三", mine: false }),
    );
    renderAt();
    const ed = await screen.findByTestId("editor");
    expect(ed.getAttribute("data-readonly")).toBe("false"); // 起始可写
    fireEvent.pointerDown(screen.getByTestId("editor-shell"));
    await waitFor(() => expect(api.articles.acquireEditLock).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true")); // 冲突→只读
  });
});
