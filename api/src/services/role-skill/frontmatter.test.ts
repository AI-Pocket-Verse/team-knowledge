import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { slugify, ensureFrontmatter } from "./frontmatter.js";

// yaml 不是 api 的直接依赖（仅 workspace 内传递依赖），测试里从 pnpm 的提升目录取来做严格解析。
const require = createRequire(import.meta.url);
const yamlPath = require.resolve("yaml", { paths: [fileURLToPath(new URL("../../../../node_modules/.pnpm/node_modules", import.meta.url))] });
const YAML = require(yamlPath) as { parse: (s: string) => { name: string; description: string } };

const FB = { name: "role-abc123", description: "知识库角色" };

describe("slugify", () => {
  it("kebabs ASCII", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Assistant_Meeting 2")).toBe("assistant-meeting-2");
  });
  it("keeps leading ASCII of a mixed CJK name", () => {
    expect(slugify("Assistant知识库")).toBe("assistant");
  });
  it("returns empty for an all-CJK name", () => {
    expect(slugify("知识库")).toBe("");
  });
});

describe("ensureFrontmatter", () => {
  it("parses an existing block and normalizes it", () => {
    const raw = `---\nname: My Skill\ndescription: "Knows things"\n---\n\n# Body\ntext`;
    const r = ensureFrontmatter(raw, FB);
    expect(r.name).toBe("my-skill");
    expect(r.description).toBe("Knows things");
    expect(r.content.startsWith('---\nname: my-skill\ndescription: "Knows things"\n---\n\n')).toBe(true);
    expect(r.content).toContain("# Body");
    // exactly one frontmatter block
    expect(r.content.match(/^---/gm)?.length).toBe(2);
  });

  it("backfills a missing description from fallback", () => {
    const raw = `---\nname: kb\n---\n\nbody`;
    const r = ensureFrontmatter(raw, FB);
    expect(r.name).toBe("kb");
    expect(r.description).toBe(FB.description);
  });

  it("prepends frontmatter when none present", () => {
    const r = ensureFrontmatter("# Just body\nno frontmatter", FB);
    expect(r.name).toBe(FB.name);
    expect(r.description).toBe(FB.description);
    expect(r.content.startsWith(`---\nname: ${FB.name}\ndescription: ${JSON.stringify(FB.description)}\n---\n\n`)).toBe(true);
    expect(r.content).toContain("# Just body");
  });

  it("falls back when the parsed name has no ASCII", () => {
    const raw = `---\nname: 知识库\ndescription: 中文描述\n---\n\nbody`;
    const r = ensureFrontmatter(raw, FB);
    expect(r.name).toBe(FB.name); // slugify("知识库") === "" → fallback
    expect(r.description).toBe("中文描述");
  });

  it("flattens a multi-word description to one line", () => {
    const raw = `---\nname: x\ndescription: line one\n---\nbody`;
    const r = ensureFrontmatter(raw, FB);
    expect(r.description).toBe("line one");
  });
});

describe("ensureFrontmatter 输出是合法 YAML", () => {
  const cases = [
    "产品团队知识: 规划、需求 #1",
    "[a] list",
    "> 说明",
    '含 "双引号" 与 \\ 反斜杠',
  ];
  for (const desc of cases) {
    it(`description=${JSON.stringify(desc)} 可被严格解析且值一致`, () => {
      const r = ensureFrontmatter(`---\nname: x\ndescription: ${desc}\n---\n\nbody`, FB);
      const fm = r.content.split("\n---\n")[0].replace(/^---\n/, "");
      expect(YAML.parse(fm).description).toBe(desc);
      expect(r.description).toBe(desc);
    });
  }

  it("已带引号的输入再过一遍：转义被还原，不会越转越多", () => {
    const first = ensureFrontmatter(`---\nname: x\ndescription: 说: "好"\n---\n\nbody`, FB);
    const second = ensureFrontmatter(first.content, FB);
    expect(second.description).toBe('说: "好"');
    expect(second.content).toBe(first.content);
  });
});
