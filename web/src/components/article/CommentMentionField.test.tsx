import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ api: { searchUsers: vi.fn().mockResolvedValue({ users: [] }) } }));

import { CommentMentionField, serializeEditor, renderCommentBody, mentionsToPlain } from "./CommentMentionField";

describe("serializeEditor", () => {
  it("serializes mention chips to [@name](/u/id) markdown, keeping surrounding text", () => {
    const root = document.createElement("div");
    root.append(document.createTextNode("hi "));
    const chip = document.createElement("span");
    chip.dataset.uid = "u1";
    chip.dataset.uname = "李四";
    chip.textContent = "@李四";
    root.append(chip);
    root.append(document.createTextNode(" ok"));
    expect(serializeEditor(root)).toBe("hi [@李四](/u/u1) ok");
  });

  it("returns plain text unchanged when there are no chips", () => {
    const root = document.createElement("div");
    root.append(document.createTextNode("just text"));
    expect(serializeEditor(root)).toBe("just text");
  });
});

describe("renderCommentBody", () => {
  it("renders [@name](/u/id) markers as a highlighted @name", () => {
    render(<p>{renderCommentBody("hi [@李四](/u/u1) ok")}</p>);
    expect(screen.getByText("@李四")).toBeInTheDocument();
  });
});

describe("提及显示名含 []() 与反斜杠", () => {
  const NAME = "Li [Ops] (a\\b)";
  const chipRoot = () => {
    const root = document.createElement("div");
    const chip = document.createElement("span");
    chip.dataset.uid = "u1";
    chip.dataset.uname = NAME;
    root.append(document.createTextNode("hi "), chip);
    return root;
  };

  it("序列化转义,渲染端还原成原显示名,标记不被截断", () => {
    const md = serializeEditor(chipRoot());
    expect(md).toBe("hi [@Li \\[Ops\\] \\(a\\\\b\\)](/u/u1)");
    render(<p>{renderCommentBody(md + " tail")}</p>);
    expect(screen.getByText(`@${NAME}`)).toBeInTheDocument();
    expect(screen.getByText(/tail/)).toBeInTheDocument();
  });

  it("历史上未转义的提及数据照常解析", () => {
    render(<p>{renderCommentBody("hi [@李四](/u/u1) ok")}</p>);
    expect(screen.getByText("@李四")).toBeInTheDocument();
  });

  it("草稿计数与引用摘要把整个标记还原成 @name", () => {
    const md = serializeEditor(chipRoot());
    expect(mentionsToPlain(md)).toBe(`hi @${NAME}`);
  });
});

describe("CommentMentionField", () => {
  it("renders a contentEditable composer", () => {
    render(<CommentMentionField onChange={() => {}} placeholder="留言" />);
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("contenteditable")).toBe("true");
    expect(box.getAttribute("data-placeholder")).toBe("留言");
  });
});
