import { describe, it, expect } from "vitest";
import { lintHeadingFormat } from "./formatLint.js";

describe("lintHeadingFormat", () => {
  it("标题残留 ** 加粗符号 → 报 format", () => {
    const f = lintHeadingFormat("# 正常标题\n\n## **聊天场景内容卡**\n\n正文");
    expect(f.some((x) => x.category === "format" && x.severity === "med" && /残留/.test(x.problem))).toBe(true);
  });

  it("行内代码 / 链接 / 删除线 / 下划线加粗 标题 → 报", () => {
    expect(lintHeadingFormat("# `code` 标题").length).toBeGreaterThan(0);
    expect(lintHeadingFormat("# [文字](http://x) 标题").length).toBeGreaterThan(0);
    expect(lintHeadingFormat("# ~~删~~ 标题").length).toBeGreaterThan(0);
    expect(lintHeadingFormat("# __粗__ 标题").length).toBeGreaterThan(0);
  });

  it("干净标题 → 不报", () => {
    expect(lintHeadingFormat("# 版本定位\n\n## 用户体验目标\n\n### 文案卡")).toHaveLength(0);
  });

  it("标题层级跳级(H1→H3)→ 报", () => {
    expect(lintHeadingFormat("# 一\n\n### 三").some((x) => /跳级/.test(x.problem))).toBe(true);
  });

  it("逐级递进不报;回到更高层级不算跳级", () => {
    expect(lintHeadingFormat("# 一\n\n## 二\n\n### 三\n\n## 二之二")).toHaveLength(0);
  });

  it("围栏代码块里的 # 与 ** 不当标题", () => {
    expect(lintHeadingFormat("# 真标题\n\n```\n# 代码注释 **不是标题**\n```")).toHaveLength(0);
  });
});
