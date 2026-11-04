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

describe("ChatMarkdown tables", () => {
  it("renders a GFM table right after a paragraph", () => {
    const { container } = renderMd(
      "放量节奏如下：\n| 阶段 | 流量 |\n| --- | :---: |\n| 一 | **10%** |\n| 二 | 30% |\n\n之后全量。",
    );
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["阶段", "流量"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(container.querySelector("td strong")?.textContent).toBe("10%");
    expect(container.textContent).not.toContain("---");
    expect(screen.getByText("放量节奏如下：")).toBeInTheDocument();
    expect(screen.getByText("之后全量。")).toBeInTheDocument();
  });

  it("keeps a half-streamed table (no separator yet) as plain text", () => {
    renderMd("| 阶段 | 流量 |");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("| 阶段 | 流量 |")).toBeInTheDocument();
  });
});

describe("ChatMarkdown nested lists", () => {
  it("nests indented items under the previous list item", () => {
    const { container } = renderMd("- 分页上限不一致：\n  - 接口规范：100\n  - 架构总览：200\n- 其他");
    const top = container.querySelectorAll(":scope > div > ul > li");
    expect(top).toHaveLength(2);
    expect([...top[0].querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["接口规范：100", "架构总览：200"]);
    expect(container.textContent).not.toMatch(/-\s*接口规范/);
  });
});

describe("ChatMarkdown nested ordered lists", () => {
  it("keeps numbering for indented numbered sub-items", () => {
    const { container } = renderMd("- 步骤：\n  1. 通知\n  2. 切流量");
    expect([...container.querySelectorAll("ul > li > ol > li")].map((li) => li.textContent)).toEqual(["通知", "切流量"]);
  });
});
