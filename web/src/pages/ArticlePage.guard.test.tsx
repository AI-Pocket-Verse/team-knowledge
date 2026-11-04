import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// 编辑器替身:在挂载后模拟真实 Crepe 的「加载归一化」——先 onReady 回传基线,
// 再 onChange 报一个与基线不同的归一化值(尾换行),制造 autosaveDirty=true。
// 这正是历史 bug 的形态:纯查看一篇文档,加载噪声让它「变脏」,切换文档就弹
// 「有未保存的修改,确定离开?」。用它守护:查看态下该噪声不得进全局守卫。
vi.mock("@/components/article/MilkdownEditor", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    MilkdownEditor: ({
      initialMarkdown,
      onChange,
      onReady,
    }: {
      initialMarkdown: string;
      onChange?: (md: string) => void;
      onReady?: (md: string) => void;
    }) => {
      useEffect(() => {
        // 异步发出(模拟真实 Crepe:create() 之后、父级初始化 effect 之后才回调),
        // 否则父级 [article.id] 初始化 effect 会把 body 又刷回原值,掩盖脏态。
        const t = setTimeout(() => {
          onReady?.(initialMarkdown);
          onChange?.(initialMarkdown + "\n"); // 归一化噪声:body ≠ baseline,持续为脏
        }, 0);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="editor">{initialMarkdown}</div>;
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
      notifications: { readByArticle: vi.fn().mockResolvedValue({ unread: 0 }) },
      comments: { list: vi.fn().mockResolvedValue({ comments: [] }), add: vi.fn(), remove: vi.fn() },
    },
  };
});
import { api } from "@/lib/api";
import { ArticlePage } from "./ArticlePage";
import { useUnsavedGuard } from "@/stores/unsavedGuard";

// 未命名、纯查看(无编辑权限 → 不会进入编辑态)的文档。
const viewOnlyArticle = {
  id: "a1", title: "未命名文档", contentMarkdown: "",
  roleId: "r1", folderId: null, role: { id: "r1", name: "角色" }, folder: null,
  createdBy: { id: "u9", displayName: "作者" }, createdById: "u9",
  updatedAt: "2026-06-18T00:00:00.000Z", createdAt: "2026-06-18T00:00:00.000Z",
  sortOrder: 0, inboundRefs: [], versionsCount: 0,
  isLiked: false, likeCount: 0, isBookmarked: false, bookmarkCount: 0, commentCount: 0, editing: null,
  permissions: { canView: true, canEdit: false, canBookmark: true, canCite: true, canExport: true, canManageEditors: false, isReadOnly: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  useUnsavedGuard.getState().setDirty(false);
});

describe("ArticlePage 未保存守卫", () => {
  it("查看态下编辑器加载归一化噪声不置全局 dirty(不误触发离开拦截)", async () => {
    (api.articles.get as ReturnType<typeof vi.fn>).mockResolvedValue({ article: viewOnlyArticle });
    render(
      <MemoryRouter initialEntries={["/d/a1"]}>
        <Routes><Route path="/d/:docId" element={<ArticlePage />} /></Routes>
      </MemoryRouter>,
    );
    // 等编辑器替身挂载并发出 onReady + onChange(归一化噪声)。
    await screen.findByTestId("editor");
    // 关键断言:查看态(editing=false)下,归一化噪声不得镜像进全局守卫,
    // 否则切换文档会弹「有未保存的修改,确定离开?」。
    await waitFor(() => expect(useUnsavedGuard.getState().dirty).toBe(false));
    // 再多等一拍,确保任何后续渲染都不会把它翻脏。
    await new Promise((r) => setTimeout(r, 20));
    expect(useUnsavedGuard.getState().dirty).toBe(false);
  });
});
