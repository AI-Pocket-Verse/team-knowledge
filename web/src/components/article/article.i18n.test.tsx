import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ api: {} }));

import { setCurrentLang } from "@/i18n/lang";
import { MESSAGES } from "@/i18n/messages";
import { ImageUploadPlaceholder } from "./ImageUploadPlaceholder";
import { ReviewDiffDialog } from "./ReviewDiffDialog";
import { ReviewBadge } from "@/lib/reviewBadge";

afterEach(() => setCurrentLang("zh"));

describe("article i18n", () => {
  it("renders the upload placeholder in the current language", () => {
    const { rerender } = render(<ImageUploadPlaceholder state="uploading" />);
    expect(screen.getByText("上传中…")).toBeInTheDocument();
    setCurrentLang("en");
    rerender(<ImageUploadPlaceholder state="error" />);
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
  });

  it("renders the review diff dialog with English copy and plural forms", () => {
    setCurrentLang("en");
    render(
      <ReviewDiffDialog
        open
        articleId="a1"
        before={"a\nb"}
        after={"a\nc"}
        findingsCount={1}
        unlocated={2}
        onCancel={() => {}}
        onApplied={() => {}}
      />,
    );
    expect(screen.getByText("Optimization preview · pick the changes to apply")).toBeInTheDocument();
    expect(screen.getByText(/proposed fixes for 1 issue, resulting in 1 text change/)).toBeInTheDocument();
    expect(screen.getByText(/couldn't locate 2 other issues/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders the review badge label in English", () => {
    setCurrentLang("en");
    render(<ReviewBadge title="x" />);
    expect(screen.getByLabelText("Needs work")).toBeInTheDocument();
  });

  it("keeps placeholders consistent between zh and en for every article key", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)].map((m) => m[1]);
    const uniq = (s: string) => [...new Set(vars(s))].sort();
    for (const key of Object.keys(MESSAGES.zh).filter((k) => k.startsWith("article."))) {
      const k = key as keyof typeof MESSAGES.zh;
      expect(uniq(MESSAGES.en[k]), key).toEqual(uniq(MESSAGES.zh[k]));
    }
  });
});
