import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation, useParams } from "react-router-dom";

vi.mock("@/lib/api", async (o) => {
  const a = await o<typeof import("@/lib/api")>();
  return { ...a, api: { ...a.api, articles: { create: vi.fn().mockResolvedValue({ article: { id: "new-123" } }) } } };
});
import { api } from "@/lib/api";
import { NewArticleRedirect } from "./NewArticleRedirect";

// 目标页探针:展示 docId + 是否带 justCreated state。
function DocProbe() {
  const { docId } = useParams<{ docId: string }>();
  const state = useLocation().state as { justCreated?: boolean } | null;
  return <div>doc {docId} {state?.justCreated ? "new" : "old"}</div>;
}

beforeEach(() => vi.clearAllMocks());

describe("NewArticleRedirect", () => {
  it("建空文档后跳到 /d/:id 并带 justCreated", async () => {
    render(
      <MemoryRouter initialEntries={["/d/new?roleId=r1&folderId=f1"]}>
        <Routes>
          <Route path="/d/new" element={<NewArticleRedirect />} />
          <Route path="/d/:docId" element={<DocProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(api.articles.create).toHaveBeenCalledWith({ roleId: "r1", folderId: "f1", title: "", contentMarkdown: "" }),
    );
    await screen.findByText("doc new-123 new");
  });

  it("缺少 roleId → 报错不创建", async () => {
    render(
      <MemoryRouter initialEntries={["/d/new"]}>
        <Routes>
          <Route path="/d/new" element={<NewArticleRedirect />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/缺少 roleId 参数/);
    expect(api.articles.create).not.toHaveBeenCalled();
  });
});
