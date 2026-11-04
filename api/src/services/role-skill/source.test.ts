import { describe, it, expect } from "vitest";
import {
  computeSourceHash, packArticles, batchArticles, buildDocIndex, MAX_INPUT_CHARS, MAX_INDEX_DOCS,
} from "./source.js";

describe("batchArticles", () => {
  const doc = (title: string, chars: number) => ({ title, contentMarkdown: "x".repeat(chars) });
  it("总量在预算内 → 1 批", () => {
    const b = batchArticles([doc("a", 100), doc("b", 100)], 1000);
    expect(b).toHaveLength(1);
    expect(b[0]).toHaveLength(2);
  });
  it("超预算 → 多批,每批不超预算(单篇超预算除外),不丢文档", () => {
    const arts = [doc("a", 400), doc("b", 400), doc("c", 400)];
    const b = batchArticles(arts, 1000);
    expect(b.length).toBeGreaterThan(1);
    for (const batch of b) {
      const used = batch.reduce((n, a) => n + `## ${a.title}\n\n${a.contentMarkdown}`.length, 0);
      expect(used <= 1000 || batch.length === 1).toBe(true);
    }
    expect(b.flat()).toHaveLength(3);
  });
  it("单篇超预算 → 独占一批", () => {
    const b = batchArticles([doc("big", 5000), doc("small", 100)], 1000);
    expect(b[0]).toHaveLength(1);
    expect(b[0][0].title).toBe("big");
  });
});

const T0 = new Date("2026-06-06T00:00:00Z");
const T1 = new Date("2026-06-06T01:00:00Z");

describe("computeSourceHash", () => {
  const base = {
    name: "Assistant知识库",
    description: "团队知识",
    articles: [
      { id: "a", title: "入门", updatedAt: T0 },
      { id: "b", title: "进阶", updatedAt: T1 },
    ],
  };

  it("is stable for identical input", () => {
    expect(computeSourceHash(base)).toBe(computeSourceHash({ ...base }));
  });

  it("ignores article ORDER (sorted internally)", () => {
    const reordered = { ...base, articles: [base.articles[1]!, base.articles[0]!] };
    expect(computeSourceHash(reordered)).toBe(computeSourceHash(base));
  });

  it("changes when a title changes", () => {
    const edited = { ...base, articles: [{ ...base.articles[0]!, title: "入门(改)" }, base.articles[1]!] };
    expect(computeSourceHash(edited)).not.toBe(computeSourceHash(base));
  });

  it("changes when a doc's updatedAt changes", () => {
    const edited = { ...base, articles: [{ ...base.articles[0]!, updatedAt: T1 }, base.articles[1]!] };
    expect(computeSourceHash(edited)).not.toBe(computeSourceHash(base));
  });

  it("changes when the role name or description changes", () => {
    expect(computeSourceHash({ ...base, name: "其他" })).not.toBe(computeSourceHash(base));
    expect(computeSourceHash({ ...base, description: "变了" })).not.toBe(computeSourceHash(base));
    expect(computeSourceHash({ ...base, description: null })).not.toBe(computeSourceHash(base));
  });

  it("changes when a doc is added or removed", () => {
    const fewer = { ...base, articles: [base.articles[0]!] };
    expect(computeSourceHash(fewer)).not.toBe(computeSourceHash(base));
  });
});

describe("packArticles", () => {
  it("includes full content when under budget; truncated=0", () => {
    const r = packArticles([
      { title: "T1", contentMarkdown: "hello" },
      { title: "T2", contentMarkdown: "world" },
    ]);
    expect(r.docCount).toBe(2);
    expect(r.truncated).toBe(0);
    expect(r.body).toContain("## T1");
    expect(r.body).toContain("hello");
    expect(r.body).toContain("world");
  });

  it("truncates docs that overflow the budget, counting them", () => {
    const big = "x".repeat(50);
    const r = packArticles(
      [
        { title: "A", contentMarkdown: big },
        { title: "B", contentMarkdown: big }, // overflows the tiny budget
        { title: "C", contentMarkdown: big },
      ],
      60, // budget fits ~first doc only
    );
    expect(r.docCount).toBe(3); // index/count covers all docs
    expect(r.truncated).toBeGreaterThanOrEqual(1);
    expect(r.body).toContain("## A");
    expect(r.body).toContain("## B"); // still present, just reduced
  });

  it("reduces a single doc larger than the whole budget", () => {
    const huge = "y".repeat(MAX_INPUT_CHARS + 1000);
    const r = packArticles([{ title: "Huge", contentMarkdown: huge }]);
    expect(r.docCount).toBe(1);
    expect(r.truncated).toBe(1);
    expect(r.body.length).toBeLessThan(huge.length);
    expect(r.body).toContain("正文已截断");
  });

  it("omits bodies entirely once the budget is fully spent (bounded output for huge roles)", () => {
    const big = "z".repeat(60);
    const arts = Array.from({ length: 50 }, (_, i) => ({ title: `D${i}`, contentMarkdown: big }));
    const r = packArticles(arts, 80); // budget fits ~the first doc only
    expect(r.docCount).toBe(50); // every doc still counted
    expect(r.truncated).toBe(49); // 1 reduced at the boundary + 48 omitted
    expect(r.body.length).toBeLessThan(400); // NOT 50×60 — body is bounded
  });
});

describe("buildDocIndex", () => {
  it("lists every title as a bullet", () => {
    expect(buildDocIndex([{ title: "甲" }, { title: "乙" }])).toBe("- 甲\n- 乙");
  });
  it("placeholder when empty", () => {
    expect(buildDocIndex([])).toContain("暂无");
  });
  it("caps the index for very large roles with a +N tail", () => {
    const arts = Array.from({ length: MAX_INDEX_DOCS + 5 }, (_, i) => ({ title: `T${i}` }));
    const idx = buildDocIndex(arts);
    expect(idx).toContain("另有 5 篇");
    expect(idx.split("\n").length).toBe(MAX_INDEX_DOCS + 1); // 300 bullets + 1 tail line
  });
});
