import { describe, expect, it } from "vitest";
import { buildChatPrompt } from "./build.js";

const hit = (i: number) => ({
  articleId: `a${i}`,
  title: `Article ${i}`,
  snippet: "…",
  body: `body ${i}`,
  folderId: `m${i}`,
  roleId: `r${i}`,
  folderName: `Mod${i}`,
  roleName: `Role${i}`,
});

describe("buildChatPrompt", () => {
  it("includes system prompt directives;出处走芯片,不再指示正文用 [#N] 角标", () => {
    const r = buildChatPrompt({ retrieved: [], history: [], userMessage: "?" });
    expect(r.systemPrompt).toMatch(/团队知识库/);
    expect(r.systemPrompt).not.toMatch(/角标标注引用/);
  });

  it("inserts retrieved articles with numeric refs", () => {
    const r = buildChatPrompt({ retrieved: [hit(1), hit(2)], history: [], userMessage: "?" });
    expect(r.systemPrompt).toMatch(/\[#1\] 标题:《Article 1》/);
    expect(r.systemPrompt).toMatch(/\[#2\] 标题:《Article 2》/);
  });

  it("caps history at the default 8 when no summary", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    const r = buildChatPrompt({ retrieved: [], history, userMessage: "?" });
    expect(r.history).toHaveLength(8);
    expect(r.history[0]!.content).toBe("m12");
  });

  it("respects an explicit historyCap override (summary-era 4)", () => {
    // With a summary present the route passes historyCap=4 so the
    // summary block can carry older context without burning history
    // slots.
    const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    const r = buildChatPrompt({ retrieved: [], history, userMessage: "?", historyCap: 4 });
    expect(r.history).toHaveLength(4);
    expect(r.history[0]!.content).toBe("m16");
  });

  it("injects [用户偏好] block when userPreference is present", () => {
    const r = buildChatPrompt({
      retrieved: [], history: [], userMessage: "?",
      userPreference: "回答简洁、不要客套",
    });
    expect(r.systemPrompt).toMatch(/\[用户偏好\]/);
    expect(r.systemPrompt).toMatch(/回答简洁、不要客套/);
  });

  it("omits [用户偏好] when preference is empty / whitespace", () => {
    const r = buildChatPrompt({ retrieved: [], history: [], userMessage: "?", userPreference: "   " });
    expect(r.systemPrompt).not.toMatch(/\[用户偏好\]/);
  });

  it("injects [此前对话摘要] block when summary is present", () => {
    const r = buildChatPrompt({
      retrieved: [],
      history: [],
      userMessage: "继续上面那个方案",
      summary: "用户在讨论登录流程,AI 建议先做 SSO。",
    });
    expect(r.systemPrompt).toMatch(/\[此前对话摘要\]/);
    expect(r.systemPrompt).toMatch(/AI 建议先做 SSO/);
  });

  it("omits the summary block when summary is empty/missing", () => {
    const r1 = buildChatPrompt({ retrieved: [], history: [], userMessage: "?" });
    expect(r1.systemPrompt).not.toMatch(/\[此前对话摘要\]/);
    const r2 = buildChatPrompt({ retrieved: [], history: [], userMessage: "?", summary: "   " });
    expect(r2.systemPrompt).not.toMatch(/\[此前对话摘要\]/);
  });

  it("injects a [角色技能] block (frontmatter stripped) when skills are present", () => {
    const r = buildChatPrompt({
      retrieved: [], history: [], userMessage: "帮我写个需求",
      skills: [{ label: "产品", content: "---\nname: pm\ndescription: d\n---\n\n# 产品技能\n按 PRD 模板输出" }],
    });
    expect(r.systemPrompt).toMatch(/\[角色技能\]/);
    expect(r.systemPrompt).toMatch(/## 技能:产品/);
    expect(r.systemPrompt).toMatch(/按 PRD 模板输出/);
    // Frontmatter metadata is stripped from the injected body.
    expect(r.systemPrompt).not.toMatch(/name: pm/);
    // Placed before the corpus so the model reads the guide first.
    expect(r.systemPrompt.indexOf("[角色技能]")).toBeLessThan(r.systemPrompt.indexOf("[参考资料]"));
  });

  it("omits [角色技能] when no skills (or only empty content) are passed", () => {
    expect(buildChatPrompt({ retrieved: [], history: [], userMessage: "?" }).systemPrompt).not.toMatch(/\[角色技能\]/);
    const r = buildChatPrompt({ retrieved: [], history: [], userMessage: "?", skills: [{ label: "产品", content: "---\nname: pm\n---\n" }] });
    expect(r.systemPrompt).not.toMatch(/\[角色技能\]/);
  });

  it("labels a skill mention as 技能「…」 in the [用户范围] hint", () => {
    const r = buildChatPrompt({
      retrieved: [], history: [], userMessage: "?",
      mentions: [{ type: "skill", id: "r1", label: "产品" }],
    });
    expect(r.systemPrompt).toMatch(/技能「产品」/);
  });

  it("returns the user message verbatim", () => {
    const r = buildChatPrompt({ retrieved: [], history: [], userMessage: "hello" });
    expect(r.userMessage).toBe("hello");
  });

  it("returns the article ids in citation order so the route can persist them", () => {
    const r = buildChatPrompt({ retrieved: [hit(1), hit(2)], history: [], userMessage: "?" });
    expect(r.citedArticleIds).toEqual(["a1", "a2"]);
  });

  it("exposes includedHits matching the cited ids and [#N] order", () => {
    const r = buildChatPrompt({ retrieved: [hit(1), hit(2)], history: [], userMessage: "?" });
    expect(r.includedHits.map((h) => h.articleId)).toEqual(["a1", "a2"]);
    expect(r.includedHits.map((h) => h.articleId)).toEqual(r.citedArticleIds);
  });

  // (#8) Citation over-claim regression: docs the corpus cap excludes
  // must NOT be reported as cited, and the surviving docs must be
  // numbered [#1..#k] with no gaps so the model can't cite a source it
  // never received. NB: the SYSTEM_PREAMBLE itself literally contains
  // "[#1] [#2]" as instruction text, so we assert on citedArticleIds /
  // includedHits (the authoritative set) and on the corpus body — not
  // on the whole systemPrompt — when checking which [#N] headers exist.
  it("drops a doc entirely when no meaningful chunk fits, so it isn't cited", () => {
    // First doc nearly fills the 80K budget; the second can't get a
    // meaningful chunk (remaining ≤ 200) → dropped wholesale, no header.
    const huge = { ...hit(1), body: "x".repeat(79_900) };
    const overflow = { ...hit(2), body: "y".repeat(5_000) };
    const r = buildChatPrompt({ retrieved: [huge, overflow], history: [], userMessage: "?" });
    expect(r.citedArticleIds).toEqual(["a1"]);
    expect(r.includedHits.map((h) => h.articleId)).toEqual(["a1"]);
    // The dropped doc gets no [#N] header and no title in the corpus.
    expect(r.systemPrompt).not.toMatch(/Article 2/);
    // The corpus carries exactly one numbered ref header.
    const corpus = r.systemPrompt.split("[参考资料]\n")[1] ?? "";
    expect(corpus.match(/\[#\d+\] 标题:/g)).toEqual(["[#1] 标题:"]);
  });

  it("numbers surviving docs gap-free by included position, not pre-cap index", () => {
    // doc1 fits (gets [#1]); doc2 overflows and is dropped; if doc3
    // could fit it would be [#2], NOT [#3]. Here only doc1 survives, so
    // the corpus must show exactly [#1] with no [#2]/[#3] header.
    const huge = { ...hit(1), body: "x".repeat(79_900) };
    const drop2 = { ...hit(2), body: "y".repeat(5_000) };
    const drop3 = { ...hit(3), body: "z".repeat(5_000) };
    const r = buildChatPrompt({ retrieved: [huge, drop2, drop3], history: [], userMessage: "?" });
    expect(r.citedArticleIds).toEqual(["a1"]);
    const corpus = r.systemPrompt.split("[参考资料]\n")[1] ?? "";
    expect(corpus).toMatch(/\[#1\] 标题:《Article 1》/);
    expect(corpus).not.toMatch(/\[#2\]/);
    expect(corpus).not.toMatch(/\[#3\]/);
  });
});
