// 编辑器初始化失败(如 Milkdown 升级后 API 变化)时，用户要看到明确提示，而不是空白编辑区。
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@milkdown/crepe", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@milkdown/crepe")>();
  class FailingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      // create 是实例上的成员，在构造后覆盖
      (this as unknown as { create: () => Promise<never> }).create = () => Promise.reject(new Error("boom"));
    }
  }
  return { ...mod, Crepe: FailingCrepe };
});

import { MilkdownEditor } from "./MilkdownEditor";

describe("MilkdownEditor 初始化失败", () => {
  it("显示可见的错误提示和刷新入口", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MilkdownEditor initialMarkdown="" onChange={() => {}} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("编辑器加载失败");
    expect(alert.textContent).toContain("boom");
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeTruthy();
  });
});
