// Runtime mount test — verifies Milkdown actually finishes editor.create()
// and produces a contenteditable .ProseMirror child. The earlier smoke test
// only asserts the outer wrapper renders; this one waits for the async
// editor boot and surfaces any init failure in test output.
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MilkdownEditor } from "./MilkdownEditor";

describe("MilkdownEditor runtime", () => {
  it("eventually renders a contenteditable .ProseMirror inside the wrapper", async () => {
    const { container } = render(
      <MilkdownEditor initialMarkdown="" onChange={() => {}} />,
    );
    await waitFor(() => {
      const pm = container.querySelector(".tm-editor .ProseMirror");
      expect(pm, "Milkdown failed to mount a .ProseMirror contenteditable").toBeTruthy();
      expect(pm?.getAttribute("contenteditable")).toBe("true");
    }, { timeout: 4000 });
  });

  // Regression: 加载即变脏。Crepe 在创建时会把 initialMarkdown 归一化(尾换行/
  // 列表符号等),历史上这个「非用户」变更经 markdownUpdated 误报为 onChange →
  // 查看态下 body≠baseline → dirty=true → 切换文档弹「有未保存的修改」。onChange
  // 必须在 onReady(基线对齐)之后才放行,onReady 之前不得有任何 onChange。
  it("does not fire onChange before onReady (no false 'unsaved changes' on load)", async () => {
    const events: string[] = [];
    let readyMd: string | null = null;
    render(
      <MilkdownEditor
        initialMarkdown={"* one\n* two\n"}
        onChange={() => events.push("change")}
        onReady={(md) => { events.push("ready"); readyMd = md; }}
      />,
    );
    await waitFor(() => expect(events).toContain("ready"), { timeout: 4000 });
    const readyIdx = events.indexOf("ready");
    const changeIdx = events.indexOf("change");
    // 任何 onChange(若有)都必须晚于 onReady —— 就绪前的归一化不得外泄为编辑。
    expect(changeIdx === -1 || changeIdx > readyIdx).toBe(true);
    expect(readyMd).not.toBeNull();
  });
});
