import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ArticleTimeFeed } from "./ArticleTimeFeed";
import { api } from "@/lib/api";

// Only api.feed (and listRoles, unused in folder mode) are exercised here.
vi.mock("@/lib/api", () => ({
  api: {
    feed: vi.fn(async () => ({
      articles: [
        {
          id: "d1", title: "需求文档", roleName: "产品", roleColor: "violet",
          folderName: "PRD", status: "published", updatedAt: new Date().toISOString(),
          createdBy: { id: "u1", displayName: "W" },
        },
      ],
    })),
    workspace: { listRoles: vi.fn(async () => ({ roles: [] })) },
  },
}));

beforeEach(() => { vi.clearAllMocks(); });

describe("ArticleTimeFeed", () => {
  it("fetches the feed once for a stable folder mode", async () => {
    render(
      <MemoryRouter>
        <ArticleTimeFeed mode={{ kind: "folder", folderId: "m1", folderName: "PRD" }} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("需求文档")).toBeInTheDocument());
    expect(api.feed).toHaveBeenCalledTimes(1);
    expect(api.feed).toHaveBeenCalledWith({ folderId: "m1" });
  });

  it("does NOT refetch when the parent re-renders with a fresh mode object of identical primitives", async () => {
    // Mirrors ArticleListPage, which passes `mode` as a NEW object literal on
    // every render. The fetch effect must depend on the mode PRIMITIVES (kind
    // / folderId / roleId), not the object identity — otherwise an unrelated
    // parent re-render re-fetches the feed and flashes the loader.
    function Harness() {
      const [, force] = useState(0);
      return (
        <div>
          <button onClick={() => force((n) => n + 1)}>rerender</button>
          {/* Fresh object literal each render — identical primitives. */}
          <ArticleTimeFeed mode={{ kind: "folder", folderId: "m1", folderName: "PRD" }} />
        </div>
      );
    }
    render(<MemoryRouter><Harness /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("需求文档")).toBeInTheDocument());
    expect(api.feed).toHaveBeenCalledTimes(1);

    // Force three parent re-renders; the feed must NOT be re-fetched.
    fireEvent.click(screen.getByText("rerender"));
    fireEvent.click(screen.getByText("rerender"));
    fireEvent.click(screen.getByText("rerender"));
    await Promise.resolve();
    expect(api.feed).toHaveBeenCalledTimes(1);
  });
});
