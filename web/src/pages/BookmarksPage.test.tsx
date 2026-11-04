import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookmarksPage } from "./BookmarksPage";

vi.mock("@/lib/api", () => {
  const baseArticle = {
    id: "a1", title: "需求文档", contentMarkdown: "x", status: "published" as const,
    folderId: "m1", createdById: "u1",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    permissions: { canView: true, canEdit: true, canBookmark: true, canCite: true, canExport: true, isReadOnly: false },
    createdBy: { id: "u1", displayName: "Wenxuan" },
    isBookmarked: true,
    folder: { id: "m1", name: "需求池" } as Record<string, unknown>,
    role: { id: "r1", name: "产品" } as Record<string, unknown>,
    inboundRefs: [],
    versionsCount: 0,
  };
  return {
    api: {
      bookmarks: {
        list: vi.fn().mockResolvedValue({ bookmarks: [{ article: baseArticle, createdAt: new Date().toISOString() }] }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

describe("BookmarksPage", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("renders bookmarked article rows", async () => {
    render(<MemoryRouter><BookmarksPage /></MemoryRouter>);
    expect(await screen.findByText("需求文档")).toBeInTheDocument();
    expect(await screen.findByText(/产品 \/ 需求池/)).toBeInTheDocument();
  });

  it("clicking ★ removes the bookmark", async () => {
    const { api } = await import("@/lib/api");
    render(<MemoryRouter><BookmarksPage /></MemoryRouter>);
    await screen.findByText("需求文档");
    fireEvent.click(screen.getByRole("button", { name: /取消收藏/ }));
    await waitFor(() => expect(api.bookmarks.remove).toHaveBeenCalledWith("a1"));
  });
});
