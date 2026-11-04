import { describe, it, expect } from "vitest";
import type { ChatMessageRow } from "@team-knowledge/shared";
import { buildShareMarkdown } from "./ShareToDocDialog";

function msg(id: string, role: "user" | "assistant", content: string): ChatMessageRow {
  return { id, role, content, citedArticleIds: [], citedRefs: [], mentions: [], createdAt: new Date(0).toISOString() };
}

describe("buildShareMarkdown", () => {
  it("renders a user message as a 🙋 用户 blockquote card", () => {
    const md = buildShareMarkdown([msg("a", "user", "什么是 V2")]);
    expect(md).toContain("> **🙋 用户**");
    // Body is quoted so it stays inside the same blockquote as the label.
    expect(md).toContain("> 什么是 V2");
  });

  it("renders an assistant message as a 🤖 AI blockquote card", () => {
    const md = buildShareMarkdown([msg("b", "assistant", "V2 是新版本")]);
    expect(md).toContain("> **🤖 AI**");
    expect(md).toContain("> V2 是新版本");
  });

  it("emits one card per message, in order", () => {
    const md = buildShareMarkdown([
      msg("a", "user", "问题一"),
      msg("b", "assistant", "答一"),
      msg("c", "user", "问题二"),
    ]);
    // One role-label line per message = three cards.
    expect(md.match(/> \*\*(🙋 用户|🤖 AI)\*\*/g)?.length).toBe(3);
    expect(md.indexOf("问题一")).toBeLessThan(md.indexOf("问题二"));
    // The old turn-divider rule is gone — cards are self-delimiting.
    expect(md).not.toContain("---");
  });

  it("handles an assistant message selected without its question", () => {
    const md = buildShareMarkdown([msg("b", "assistant", "孤立回答")]);
    expect(md).toContain("> **🤖 AI**");
    expect(md).toContain("> 孤立回答");
    expect(md).not.toContain("🙋 用户");
  });

  it("substitutes a placeholder for empty content", () => {
    const md = buildShareMarkdown([msg("b", "assistant", "")]);
    expect(md).toContain("_（无内容）_");
  });

  it("keeps a multi-line body inside one blockquote (every line quoted)", () => {
    const md = buildShareMarkdown([msg("a", "user", "第一行\n第二行")]);
    expect(md).toContain("> 第一行");
    expect(md).toContain("> 第二行");
  });

  it("embeds attached images as quoted markdown images inside the card", () => {
    const md = buildShareMarkdown([{ ...msg("a", "user", "看这张"), images: ["/uploads/abc.png", "/uploads/def.jpg"] }]);
    expect(md).toContain("> ![图片](/uploads/abc.png)");
    expect(md).toContain("> ![图片](/uploads/def.jpg)");
    expect(md).toContain("> 看这张");
  });

  it("for an image-only message, emits the image but no （空）/（无内容） placeholder", () => {
    const md = buildShareMarkdown([{ ...msg("a", "user", ""), images: ["/uploads/x.png"] }]);
    expect(md).toContain("> ![图片](/uploads/x.png)");
    expect(md).not.toContain("（空）");
    expect(md).not.toContain("（无内容）");
  });
});
