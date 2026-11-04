import { describe, it, expect } from "vitest";
import { buildChatShareSvg } from "./svg.js";

describe("buildChatShareSvg", () => {
  it("produces a well-formed SVG sized by a viewBox with the title + role labels", () => {
    const svg = buildChatShareSvg(
      [
        { role: "user", content: "这个项目怎么部署？" },
        { role: "assistant", content: "用 `deploy.sh update` 一键部署。" },
      ],
      { title: "我的对话", dateLabel: "摘自 AI 对话 · 2026/06/16" },
    );
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 720 \d+"/);
    expect(svg).toContain("我的对话");
    expect(svg).toContain("摘自 AI 对话 · 2026/06/16");
    // Role labels are TEXT (not emoji — the bundled font has no emoji glyphs).
    expect(svg).toContain(">用户</text>");
    expect(svg).toContain(">AI</text>");
    // Inline code becomes a styled tspan, not a literal backtick.
    expect(svg).toContain("deploy.sh update");
    expect(svg).not.toContain("`");
  });

  it("escapes XML-significant characters in message content", () => {
    const svg = buildChatShareSvg([{ role: "user", content: "a < b && c > d" }]);
    expect(svg).toContain("a &lt; b &amp;&amp; c &gt; d");
  });

  it("grows the canvas height with more messages", () => {
    const h = (n: number) => {
      const msgs = Array.from({ length: n }, () => ({ role: "user" as const, content: "一句话" }));
      return Number(buildChatShareSvg(msgs).match(/viewBox="0 0 720 (\d+)"/)![1]);
    };
    expect(h(5)).toBeGreaterThan(h(1));
  });

  it("renders a placeholder for empty assistant content", () => {
    const svg = buildChatShareSvg([{ role: "assistant", content: "" }]);
    expect(svg).toContain("（无内容）");
  });

  it("ellipsizes an over-long title so it can't overflow the canvas width", () => {
    const longTitle = "标".repeat(200);
    const svg = buildChatShareSvg([{ role: "user", content: "x" }], { title: longTitle });
    expect(svg).toContain("…");
    expect(svg).not.toContain("标".repeat(200)); // the full run never makes it in
  });

  it("embeds attached images as <image> data URIs", () => {
    const uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const svg = buildChatShareSvg([{ role: "user", content: "看这张图", images: [uri] }]);
    expect(svg).toContain(`<image href="${uri}"`);
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it("omits the （无内容） placeholder for an image-only message", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    const svg = buildChatShareSvg([{ role: "user", content: "", images: [uri] }]);
    expect(svg).toContain("<image href=");
    expect(svg).not.toContain("（无内容）");
    expect(svg).not.toContain("（空）");
  });

  it("正文总字数超过上限时截断并提示(栅格化耗时与字数成正比,画布高度管不住)", () => {
    const svg = buildChatShareSvg([{ role: "user", content: "啊".repeat(60_000) }]);
    expect((svg.match(/啊/g) ?? []).length).toBeLessThanOrEqual(6_000);
    expect(svg).toContain("图片已截断");
  });

  it("按字数截断时不切开代理对", () => {
    const svg = buildChatShareSvg([{ role: "user", content: "a".repeat(5_999) + "😀".repeat(10) }]);
    expect(svg).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("预算恰好用到代理对中间时不再画出「（无内容）」气泡", () => {
    const svg = buildChatShareSvg([
      { role: "user", content: "a".repeat(5_999) },
      { role: "assistant", content: "😀后面的内容" },
    ]);
    expect(svg).not.toContain("（无内容）");
    expect(svg).toContain("图片已截断");
  });
});
