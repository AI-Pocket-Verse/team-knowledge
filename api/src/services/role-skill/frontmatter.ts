import { L, appLang } from "../../utils/lang.js";
// Helpers to guarantee the generated skill.md carries a well-formed Claude
// Agent Skill frontmatter (name + description). The model is asked to emit it,
// but models drift — so we parse whatever it produced, normalize it, and
// backfill from a caller-supplied fallback when missing/invalid.

/**
 * Kebab-case ASCII slug for a Claude skill `name` (a-z0-9 + hyphens). Returns
 * "" when the input has no usable ASCII alphanumerics (e.g. an all-CJK name);
 * callers supply a fallback in that case. "Assistant知识库" → "assistant".
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface Frontmatter {
  content: string;
  name: string;
  description: string;
}

const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * Ensure `raw` begins with a normalized `name`/`description` frontmatter block.
 * Parses an existing block (if any), slugifies the name, flattens the
 * description to one line, and backfills from `fallback` when missing. The
 * returned `content` always has exactly one canonical frontmatter block.
 */
export function ensureFrontmatter(raw: string, fallback: { name: string; description: string }): Frontmatter {
  const text = raw.trimStart();
  let body = text;
  let parsedName = "";
  let parsedDesc = "";

  const m = text.match(FM_RE);
  if (m) {
    body = text.slice(m[0].length);
    for (const line of (m[1] ?? "").split("\n")) {
      const nm = line.match(/^\s*name\s*:\s*(.*)$/i);
      const dm = line.match(/^\s*description\s*:\s*(.*)$/i);
      if (nm) parsedName = unquote(nm[1] ?? "");
      else if (dm) parsedDesc = unquote(dm[1] ?? "");
    }
  }

  const name = slugify(parsedName) || slugify(fallback.name) || "team-knowledge-role-skill";
  const description = oneLine(parsedDesc) || oneLine(fallback.description) || L(appLang(), "知识库角色知识技能", "Knowledge skill for a knowledge base role");
  // description 可能含 `: `、以 `[` / `>` 开头等，裸输出不是合法 YAML；JSON 字符串即合法的 YAML 双引号标量。
  const fm = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  return { content: fm + body.trimStart(), name, description };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    // 双引号标量：按 JSON 还原转义（上一次生成的输出就是这种形式）；解析不了就只去引号。
    try { return String(JSON.parse(t)).trim(); } catch { return t.slice(1, -1).trim(); }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'").trim();
  }
  return t;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
}
