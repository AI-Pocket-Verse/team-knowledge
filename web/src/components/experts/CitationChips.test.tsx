import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CitationChips } from "./CitationChips";

describe("CitationChips 联网出处", () => {
  it("http(s) 出处渲染为外链", () => {
    render(<MemoryRouter><CitationChips citations={[{ source: "web", ref: "https://example.com/a", title: "A" }]} /></MemoryRouter>);
    expect(screen.getByText(/网页 · A/).closest("a")?.getAttribute("href")).toBe("https://example.com/a");
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:x", "/d/relative", "//evil.example"])(
    "非 http(s) 出处 %s 不渲染成可点击链接",
    (ref) => {
      render(<MemoryRouter><CitationChips citations={[{ source: "web", ref, title: "B" }]} /></MemoryRouter>);
      expect(screen.getByText(/网页 · B/).closest("a")).toBeNull();
    },
  );
});
