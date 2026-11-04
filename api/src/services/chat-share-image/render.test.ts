import { describe, it, expect } from "vitest";
import { renderChatSharePng } from "./render.js";

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("renderChatSharePng", () => {
  it("rasterizes the chat-bubble SVG into a valid PNG with the bundled font", async () => {
    const png = await renderChatSharePng([
      { role: "user", content: "今天的会议结论是什么？" },
      { role: "assistant", content: "**结论**：先上线 MVP，详见 `plan.md`。\n\n- 本周联调\n- 下周灰度" },
    ]);
    expect(png.length).toBeGreaterThan(2000);             // real pixels, not blank
    expect(png.subarray(0, 8).equals(PNG_SIG)).toBe(true); // PNG magic number
    expect(png.readUInt32BE(16)).toBe(720 * 2);            // IHDR width = W × 2x scale
  }, 60_000);

  it("单条消息行数极多时在画布上限内截断", async () => {
    const content = "a\n".repeat(4000);
    const png = await renderChatSharePng([{ role: "user", content }]);
    // 修复前 4000 行要 20 秒以上、画布 11 万 px；现在与正常长对话的上限同级。
    // 断言高度而非耗时（耗时受机器负载影响）。
    // 逻辑高度上限 12000，高图 1.5x 栅格化；PNG IHDR 高度在 offset 20。
    expect(png.readUInt32BE(20)).toBeLessThanOrEqual((12_000 + 200) * 1.5);
  }, 60_000);

  it("渲染期间事件循环不被阻塞(长文字栅格化要数秒,不能卡住其他请求)", async () => {
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 20);
    try {
      await renderChatSharePng([{ role: "user", content: "啊".repeat(1500) }]);
    } finally {
      clearInterval(iv);
    }
    expect(ticks).toBeGreaterThan(5);
  }, 60_000);
});
