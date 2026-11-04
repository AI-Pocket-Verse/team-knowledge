import { describe, it, expect } from "vitest";
import { parseOptimizeEdits, applyOptimizeEdits } from "./optimize-patch.js";

describe("parseOptimizeEdits", () => {
  it("parses a clean edits JSON", () => {
    expect(parseOptimizeEdits('{"edits":[{"find":"a","replace":"b"}]}')).toEqual([{ find: "a", replace: "b" }]);
  });

  it("strips a ```json code fence and surrounding prose", () => {
    const t = '好的,以下是补丁:\n```json\n{"edits":[{"find":"旧","replace":"新"}]}\n```';
    expect(parseOptimizeEdits(t)).toEqual([{ find: "旧", replace: "新" }]);
  });

  it("drops entries missing find/replace or with empty find; keeps empty replace (deletion)", () => {
    const t = JSON.stringify({ edits: [
      { find: "keep", replace: "" },   // 删除,合法
      { find: "  ", replace: "x" },     // 空白 find,丢弃
      { find: "noreplace" },            // 缺 replace,丢弃
      { replace: "nofind" },            // 缺 find,丢弃
      { find: "ok", replace: "y" },
    ] });
    expect(parseOptimizeEdits(t)).toEqual([
      { find: "keep", replace: "" },
      { find: "ok", replace: "y" },
    ]);
  });

  it("returns [] on garbage / non-array edits", () => {
    expect(parseOptimizeEdits("not json")).toEqual([]);
    expect(parseOptimizeEdits('{"edits":"nope"}')).toEqual([]);
    expect(parseOptimizeEdits("")).toEqual([]);
  });
});

describe("applyOptimizeEdits", () => {
  it("applies a unique exact edit", () => {
    const r = applyOptimizeEdits("The quick brown fox", [{ find: "quick", replace: "slow" }]);
    expect(r).toMatchObject({ markdown: "The slow brown fox", applied: 1, failed: [] });
  });

  it("skips an ambiguous edit (find appears more than once) without touching text", () => {
    const r = applyOptimizeEdits("cat and cat", [{ find: "cat", replace: "dog" }]);
    expect(r.markdown).toBe("cat and cat");
    expect(r.applied).toBe(0);
    expect(r.failed).toEqual([{ find: "cat", reason: "ambiguous" }]);
  });

  it("reports not_found when the snippet is absent", () => {
    const r = applyOptimizeEdits("hello world", [{ find: "goodbye", replace: "x" }]);
    expect(r.applied).toBe(0);
    expect(r.failed).toEqual([{ find: "goodbye", reason: "not_found" }]);
  });

  it("falls back to whitespace-flexible matching when exact fails but a unique flex match exists", () => {
    // 原文用两个换行,模型的 find 用了一个空格 —— 精确匹配不到,宽松匹配唯一命中。
    const r = applyOptimizeEdits("步骤一\n\n步骤二", [{ find: "步骤一 步骤二", replace: "步骤 1 与 2" }]);
    expect(r.markdown).toBe("步骤 1 与 2");
    expect(r.applied).toBe(1);
  });

  it("treats regex metacharacters in find as literals (no injection / no over-match)", () => {
    const r = applyOptimizeEdits("price is $5 (approx)", [{ find: "$5 (approx)", replace: "$6" }]);
    expect(r.markdown).toBe("price is $6");
    expect(r.applied).toBe(1);
  });

  it("applies multiple edits and reports partial failures independently", () => {
    const r = applyOptimizeEdits("alpha beta gamma", [
      { find: "alpha", replace: "A" },
      { find: "zzz", replace: "Z" },   // 不存在
      { find: "gamma", replace: "G" },
    ]);
    expect(r.markdown).toBe("A beta G");
    expect(r.applied).toBe(2);
    expect(r.failed).toEqual([{ find: "zzz", reason: "not_found" }]);
  });

  it("counts a no-op edit (find === replace) as applied only when the snippet exists", () => {
    expect(applyOptimizeEdits("same", [{ find: "same", replace: "same" }]))
      .toMatchObject({ markdown: "same", applied: 1, failed: [] });
    // no-op 但片段不在文中 → 定位失败,不能记为已应用(否则会把原文当成功返回)。
    expect(applyOptimizeEdits("hello", [{ find: "absent", replace: "absent" }]))
      .toMatchObject({ markdown: "hello", applied: 0, failed: [{ find: "absent", reason: "not_found" }] });
  });

  it("supports deletion (empty replace) and sequential cascade", () => {
    // 先删 " draft",再改 title:第二条作用在第一条改过的文本上。
    const r = applyOptimizeEdits("title draft: body", [
      { find: " draft", replace: "" },
      { find: "title:", replace: "标题:" },
    ]);
    expect(r.markdown).toBe("标题: body");
    expect(r.applied).toBe(2);
  });

  it("leaves text untouched for an empty edit list", () => {
    expect(applyOptimizeEdits("unchanged", [])).toEqual({ markdown: "unchanged", applied: 0, failed: [] });
  });
});
