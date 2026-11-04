import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatComposer } from "./ChatComposer";

// 图片上传走 api.uploads.image;组件测试不打网络,直接 mock 返回 /uploads 视图。
// uploadSrc 保持真实实现的语义(测试环境 BASE_URL='/' → 原样返回)。
vi.mock("@/lib/api", () => ({
  api: { uploads: { image: vi.fn(async (f: File) => ({ url: `/uploads/${f.name}` })) } },
  uploadSrc: (u: string) => u,
}));

// Helper: set the contentEditable host's text + fire `input` so the
// component recomputes its derived `hasContent` / charCount state.
// JSDOM doesn't simulate native typing into contentEditable, so we
// drive textContent directly.
function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  fireEvent.input(editor);
}

function getEditor(): HTMLElement {
  return screen.getByRole("textbox", { name: /向 AI 提问/ });
}

describe("ChatComposer", () => {
  it("sends on Enter (without shift) — content + empty mentions list", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    typeInto(ed, "hi");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hi", [], []);
  });

  it("Shift+Enter does not send", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    typeInto(ed, "hi");
    fireEvent.keyDown(ed, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("ignores empty / whitespace input", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    typeInto(ed, "   ");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disabled prevents send", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={true} />);
    const ed = getEditor();
    typeInto(ed, "hi");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  // When the text is truncated to MAX, any mention whose
  // `@<label>` anchor falls after the cut must be dropped so the sent
  // text and mentions stay consistent (no silent retrieval-scope leak).
  it("drops mentions whose anchor falls beyond the MAX truncation point", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    // 5000 chars of filler (> MAX of 4096), then a mention chip whose
    // "@文档" text sits well past the 4096 cut.
    ed.textContent = "";
    ed.appendChild(document.createTextNode("a".repeat(5000)));
    const chip = document.createElement("span");
    chip.dataset.mentionType = "doc";
    chip.dataset.mentionId = "doc1";
    chip.dataset.mentionLabel = "文档";
    chip.textContent = "📄 文档";
    ed.appendChild(chip);
    fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    const [sentText, sentMentions] = onSend.mock.calls[0]!;
    expect(sentText.length).toBe(4096);
    expect(sentMentions).toEqual([]); // anchor was past the cut → dropped
  });

  // 待发送图片行:选图后缩略图出现在输入框内;点缩略图开 lightbox 预览;
  // 点 ✕ 删除;纯图可发送且 onSend 第三参带图片地址。
  it("图片行:预览 lightbox + ✕ 删除 + 纯图可发送", async () => {
    const onSend = vi.fn();
    const { container } = render(<ChatComposer onSend={onSend} disabled={false} />);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(fileInput).toBeTruthy();
    const file = new File(["png-bytes"], "t.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // 上传完成 → 缩略图出现
    const thumb = await screen.findByAltText("待发送图片");
    expect((thumb as HTMLImageElement).src).toContain("/uploads/t.png");

    // 点击缩略图 → lightbox 预览;关闭按钮收起
    fireEvent.click(screen.getByRole("button", { name: "预览图片" }));
    expect(screen.getByRole("dialog", { name: "图片预览" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull();

    // 纯图(无文字)可发送,images 第三参携带地址
    fireEvent.keyDown(getEditor(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("", [], ["/uploads/t.png"]);
    onSend.mockClear();

    // 再选一张,点 ✕ 删除后无图无文 → 不可发送
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "u.png", { type: "image/png" })] } });
    await screen.findByAltText("待发送图片");
    fireEvent.click(screen.getByRole("button", { name: "移除图片" }));
    await waitFor(() => expect(screen.queryByAltText("待发送图片")).toBeNull());
    fireEvent.keyDown(getEditor(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  // 粘贴图片:剪贴板里有图片(截图 / 复制图片文件)时,走与「点按钮上传」完全
  // 相同的 pickImages 流程 → 出现在待发送图片行,发送时 images 第三参携带地址。
  it("粘贴图片:与手动上传同一流程(缩略图 + 可发送带图片地址)", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    const file = new File(["png-bytes"], "paste.png", { type: "image/png" });
    // clipboardData 用最小 mock:items(kind/type/getAsFile)+ files;
    // 组件对两者都做 Array.from,故普通数组即可。
    fireEvent.paste(ed, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        files: [file],
        getData: () => "",
      },
    });
    const thumb = await screen.findByAltText("待发送图片");
    expect((thumb as HTMLImageElement).src).toContain("/uploads/paste.png");
    // 纯图可发送,onSend 第三参带图片地址——与手动上传结果一致。
    fireEvent.keyDown(getEditor(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("", [], ["/uploads/paste.png"]);
  });

  // 纯文本粘贴不应被误判为图片:剪贴板无图片项 → 不产生缩略图。
  it("粘贴纯文本不触发图片上传", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    fireEvent.paste(ed, {
      clipboardData: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
        files: [],
        getData: () => "hello",
      },
    });
    expect(screen.queryByAltText("待发送图片")).toBeNull();
  });

  // The inverse: a mention whose anchor survives the truncation is kept.
  it("keeps mentions whose anchor survives truncation", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={false} />);
    const ed = getEditor();
    ed.textContent = "";
    const chip = document.createElement("span");
    chip.dataset.mentionType = "doc";
    chip.dataset.mentionId = "doc1";
    chip.dataset.mentionLabel = "文档";
    chip.textContent = "📄 文档";
    ed.appendChild(chip); // "@文档" lands at the very start
    ed.appendChild(document.createTextNode(" " + "a".repeat(5000)));
    fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    const [, sentMentions] = onSend.mock.calls[0]!;
    expect(sentMentions).toEqual([{ type: "doc", id: "doc1", label: "文档" }]);
  });
});
