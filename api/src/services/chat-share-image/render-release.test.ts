import { describe, it, expect, vi } from "vitest";

// 排版阶段同步抛错(还没起渲染线程)时,也必须通知调用方释放并发名额。
vi.mock("./svg.js", () => ({ buildChatShareSvg: () => { throw new Error("layout boom"); } }));

import { renderChatSharePng } from "./render.js";

describe("renderChatSharePng 名额释放", () => {
  it("排版抛错:返回拒绝的 Promise,且 onExit 被调用一次", async () => {
    const onExit = vi.fn();
    await expect(renderChatSharePng([{ role: "user", content: "x" }], { onExit })).rejects.toThrow("layout boom");
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
