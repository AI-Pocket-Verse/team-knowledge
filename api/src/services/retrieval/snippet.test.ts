import { describe, it, expect } from "vitest";
import { extractSnippet } from "./snippet.js";

describe("extractSnippet", () => {
  it("returns body unchanged when shorter than window", () => {
    const body = "short doc with not much content";
    expect(extractSnippet(body, "doc", 500)).toBe(body);
  });

  it("anchors window around first keyword match (English)", () => {
    const head = "a".repeat(2000);
    const middle = "match-here";
    const tail = "z".repeat(2000);
    const body = head + middle + tail;
    const out = extractSnippet(body, "match-here", 1000);
    expect(out).toContain("match-here");
    // Should include a head-truncation marker since we sliced from a
    // position past index 0.
    expect(out).toContain("…（前文已截断）");
  });

  it("anchors on Chinese character-level matches", () => {
    const body = "a".repeat(3000) + "用户问的具体内容" + "b".repeat(3000);
    const out = extractSnippet(body, "用户问题", 1000);
    expect(out).toContain("用户问的具体内容");
  });

  it("falls back to head when no token matches", () => {
    const body = "x".repeat(5000);
    const out = extractSnippet(body, "totally-unrelated", 1000);
    expect(out.startsWith("xxxxx")).toBe(true);
    expect(out).toContain("…（剩余正文已截断）");
  });

  it("skips stopwords when picking the anchor token", () => {
    // "the" is a stopword — should NOT anchor on it. The "useful"
    // anchor token is "specific".
    const head = "irrelevant prefix ".repeat(200);
    const body = head + "the specific keyword we want" + "tail ".repeat(200);
    const out = extractSnippet(body, "the specific", 500);
    expect(out).toContain("specific keyword");
  });
});
