import { describe, it, expect } from "vitest";
import { renderRunOutput } from "./render.js";

describe("automation render", () => {
  it("飞书卡片(msg_type interactive)→ 标题 + 正文 markdown", () => {
    const out = "```json\n" + JSON.stringify({
      msg_type: "interactive",
      card: {
        header: { title: { tag: "plain_text", content: "今日 AI 动态" } },
        elements: [
          { tag: "markdown", content: "**要点一**" },
          { tag: "hr" },
          { tag: "div", text: { tag: "lark_md", content: "要点二" } },
        ],
      },
    }) + "\n```";
    const md = renderRunOutput(out);
    expect(md).toContain("# 今日 AI 动态");
    expect(md).toContain("**要点一**");
    expect(md).toContain("要点二");
  });

  it("无卡片纯 markdown → 原样返回", () => {
    expect(renderRunOutput("# 标题\n正文")).toBe("# 标题\n正文");
  });

  it("text 消息体 → 取 content.text", () => {
    expect(renderRunOutput(JSON.stringify({ msg_type: "text", content: { text: "你好世界" } }))).toBe("你好世界");
  });
});
