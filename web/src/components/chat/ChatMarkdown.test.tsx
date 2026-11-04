import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ChatMarkdown } from "./ChatMarkdown";

// (#2) Markdown link XSS: AI output is untrusted. A markdown link whose
// target carries an executable scheme (javascript:/vbscript:/data:)
// would, without scheme validation, become a clickable <a href> that
// runs JS in the user's authenticated session. safeUrl() must strip the
// href for such schemes (rendering the label as plain text) while still
// allowing http/https/mailto and in-app relative/fragment paths.
function renderMd(text: string) {
  return render(
    <MemoryRouter>
      <ChatMarkdown text={text} refs={[]} />
    </MemoryRouter>,
  );
}

describe("ChatMarkdown link safety", () => {
  it("renders http/https links as anchors with the original href", () => {
    renderMd("see [docs](https://example.com/page)");
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/page");
  });

  it("allows mailto links", () => {
    renderMd("[mail](mailto:a@b.com)");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute("href", "mailto:a@b.com");
  });

  it("allows in-app relative and fragment paths", () => {
    renderMd("[doc](/d/abc) and [anchor](#section)");
    expect(screen.getByRole("link", { name: "doc" })).toHaveAttribute("href", "/d/abc");
    expect(screen.getByRole("link", { name: "anchor" })).toHaveAttribute("href", "#section");
  });

  it("strips the href for javascript: URLs, rendering label as plain text", () => {
    // URL kept paren-free so the markdown URL group captures the whole
    // scheme (the renderer's `[^)\s]+` URL class stops at any ')').
    renderMd("[clickme](javascript:alert1)");
    // No anchor element at all — the dangerous link is downgraded to text.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("clickme")).toBeInTheDocument();
  });

  it("strips the href for data: and vbscript: URLs", () => {
    renderMd("[adoc](data:text/html;base64,PHNjcmlwdD4) and [bdoc](vbscript:msgbox)");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/adoc/)).toBeInTheDocument();
    expect(screen.getByText(/bdoc/)).toBeInTheDocument();
  });

  it("前导控制字符不能绕过 javascript: 过滤(\\u0001 / \\u001f / 内嵌制表符)", () => {
    renderMd("[c1](\u0001javascript:alert1) [c2](\u001fjavascript:alert1) [c3](java\tscript:alert1)");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/c1/)).toBeInTheDocument();
  });

  it("反斜杠写法的协议相对地址(/\\evil.com)被拒绝", () => {
    renderMd("[bs](/\\evil.com)");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("rejects protocol-relative //evil.com (no scheme but browser-resolved)", () => {
    renderMd("[xdoc](//evil.com)");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("xdoc")).toBeInTheDocument();
  });

  it("ignores case when matching the dangerous scheme", () => {
    renderMd("[cdoc](JaVaScRiPt:alert1)");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("cdoc")).toBeInTheDocument();
  });
});
