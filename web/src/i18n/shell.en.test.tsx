import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { FolderRow } from "@team-knowledge/shared";
import { setCurrentLang } from "./lang";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { fmtRelativeTime } from "@/lib/relativeTime";
import { ACTIVITY_LABEL } from "@/components/activity/ActivityFeed";
import { ROLE_PALETTE } from "@/lib/roleColors";
import { WorkspaceFolderListItem } from "@/components/workspace/WorkspaceFolderListItem";

// 外壳与工作台区域的英文渲染：证明切到英文后文案生效，且每个用例结束都改回中文。
describe("shell / workspace in English", () => {
  beforeEach(() => setCurrentLang("en"));
  afterEach(() => {
    setCurrentLang("zh");
    vi.restoreAllMocks();
  });

  function Boom(): JSX.Element {
    throw new Error("boom");
  }

  it("renders the error boundary fallback in English", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh page" })).toBeInTheDocument();
  });

  it("formats relative time, activity labels and role colours in English", () => {
    expect(fmtRelativeTime(null)).toBe("Never");
    expect(fmtRelativeTime(new Date(Date.now() - 3 * 60_000).toISOString())).toBe("3 min ago");
    expect(fmtRelativeTime(new Date(Date.now() - 24 * 3600_000).toISOString())).toBe("1 day ago");
    expect(ACTIVITY_LABEL.doc_create).toBe("New doc");
    expect(ROLE_PALETTE[0].label).toBe("Violet");
  });

  it("renders folder summaries with English plurals", () => {
    const folder = {
      id: "f1", name: "Docs", articles: [{ id: "a1" }, { id: "a2" }], children: [{ id: "c1", articles: [], children: [] }],
    } as unknown as FolderRow;
    render(<MemoryRouter><ul><WorkspaceFolderListItem folder={folder} /></ul></MemoryRouter>);
    expect(screen.getByText("1 subfolder · 2 documents")).toBeInTheDocument();
  });
});
