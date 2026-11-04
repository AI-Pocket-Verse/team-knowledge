// Raw Feishu docx blocks → internal DocNode[]. ALL Feishu-format quirks
// (numeric block_type enum, text_element_style shape) live here, isolated from
// the converter. The block_type numbers are the documented docx-v1 enum
// (confirmed via official docs research).
import type { DocNode, Inline } from "./feishuDoc.js";

// docx v1 block_type enum (subset we map; everything else → unsupported).
const BT = {
  page: 1,
  text: 2,
  h1: 3, h2: 4, h3: 5, h4: 6, h5: 7, h6: 8, h7: 9, h8: 10, h9: 11,
  bullet: 12,
  ordered: 13,
  code: 14,
  quote: 15,
  todo: 17,
  bitable: 18,
  callout: 19,
  diagram: 21,
  divider: 22,
  file: 23,
  grid: 24,
  iframe: 26,
  image: 27,
  isv: 28,
  mindnote: 29,
  sheet: 30,
  table: 31,
  board: 43,
} as const;

const HEADING_LEVEL: Record<number, number> = {
  [BT.h1]: 1, [BT.h2]: 2, [BT.h3]: 3, [BT.h4]: 4, [BT.h5]: 5,
  [BT.h6]: 6, [BT.h7]: 7, [BT.h8]: 8, [BT.h9]: 9,
};
const HEADING_KEY: Record<number, string> = {
  [BT.h1]: "heading1", [BT.h2]: "heading2", [BT.h3]: "heading3", [BT.h4]: "heading4", [BT.h5]: "heading5",
  [BT.h6]: "heading6", [BT.h7]: "heading7", [BT.h8]: "heading8", [BT.h9]: "heading9",
};
// Unsupported block_types that have NO fetchable content (placeholder only).
// Resolvable embeds (bitable/sheet/board/file) are handled in mapBlock so we
// can extract their tokens.
const PLACEHOLDER_KIND: Record<number, string> = {
  [BT.callout]: "callout",
  [BT.diagram]: "diagram",
  [BT.grid]: "grid",
  [BT.iframe]: "iframe",
  [BT.isv]: "isv",
  [BT.mindnote]: "mindnote",
  [BT.table]: "table",
};

// Split a composite Feishu token on its FIRST underscore:
//   bitable: "{app_token}_{table_id}"   sheet: "{spreadsheetToken}_{sheetId}"
function splitToken(token: string): [string, string] {
  const i = token.indexOf("_");
  return i < 0 ? [token, ""] : [token.slice(0, i), token.slice(i + 1)];
}

interface RawBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  [k: string]: unknown;
}

function decodeUrl(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

function toInlines(payload: unknown): Inline[] {
  const elements = (payload as { elements?: unknown[] })?.elements ?? [];
  const out: Inline[] = [];
  for (const raw of elements) {
    const e = raw as Record<string, any>;
    if (e.text_run) {
      const st = e.text_run.text_element_style ?? {};
      out.push({
        kind: "text",
        text: String(e.text_run.content ?? ""),
        bold: !!st.bold,
        italic: !!st.italic,
        strike: !!st.strikethrough,
        code: !!st.inline_code,
        underline: !!st.underline,
        link: st.link?.url ? decodeUrl(String(st.link.url)) : undefined,
      });
    } else if (e.mention_doc) {
      out.push({
        kind: "mention",
        label: String(e.mention_doc.title ?? "文档"),
        url: e.mention_doc.url ? decodeUrl(String(e.mention_doc.url)) : undefined,
      });
    } else if (e.mention_user) {
      // Prefer a display name; fall back to a generic label rather than dumping
      // the opaque open_id/user_id into the document body.
      const nm = e.mention_user.name;
      out.push({ kind: "mention", label: "@" + (typeof nm === "string" && nm ? nm : "用户") });
    } else if (e.equation) {
      out.push({ kind: "text", text: String(e.equation.content ?? ""), code: true });
    }
  }
  return out;
}

function codeText(payload: unknown): string {
  return toInlines(payload)
    .map((i) => (i.kind === "text" ? i.text : ""))
    .join("");
}

function mapBlock(b: RawBlock): DocNode {
  const bt = b.block_type;
  if (bt === BT.text) return { type: "paragraph", inlines: toInlines(b.text) };
  if (HEADING_LEVEL[bt]) return { type: "heading", level: HEADING_LEVEL[bt], inlines: toInlines(b[HEADING_KEY[bt]]) };
  if (bt === BT.bullet) return { type: "bullet", inlines: toInlines(b.bullet) };
  if (bt === BT.ordered) return { type: "ordered", inlines: toInlines(b.ordered) };
  if (bt === BT.todo) return { type: "todo", done: !!(b.todo as any)?.style?.done, inlines: toInlines(b.todo) };
  if (bt === BT.quote) return { type: "quote", inlines: toInlines(b.quote) };
  if (bt === BT.code) {
    // Feishu encodes language as an enum number; only pass through real string
    // hints to avoid emitting ```<number> fences.
    const lang = (b.code as any)?.style?.language;
    return { type: "code", language: typeof lang === "string" ? lang : "", text: codeText(b.code) };
  }
  if (bt === BT.divider) return { type: "divider" };
  if (bt === BT.image) return { type: "image", imageToken: String((b.image as any)?.token ?? ""), imageAlt: "" };

  // Fetchable embeds — carry their tokens so the route can resolve them into
  // a GFM table / image / link (falls back to placeholder if fetch fails).
  if (bt === BT.bitable) {
    const [appToken, tableId] = splitToken(String((b.bitable as any)?.token ?? ""));
    const node: DocNode = { type: "unsupported", unsupportedKind: "bitable" };
    if (appToken && tableId) node.embed = { kind: "bitable", appToken, tableId };
    return node;
  }
  if (bt === BT.sheet) {
    const [sheetToken, sheetId] = splitToken(String((b.sheet as any)?.token ?? ""));
    const node: DocNode = { type: "unsupported", unsupportedKind: "sheet" };
    if (sheetToken && sheetId) node.embed = { kind: "sheet", sheetToken, sheetId };
    return node;
  }
  if (bt === BT.board) {
    const token = String((b.board as any)?.token ?? "");
    const node: DocNode = { type: "unsupported", unsupportedKind: "board" };
    if (token) node.embed = { kind: "whiteboard", token };
    return node;
  }
  if (bt === BT.file) {
    const token = String((b.file as any)?.token ?? "");
    const node: DocNode = { type: "unsupported", unsupportedKind: "file" };
    if (token) node.embed = { kind: "file", token, name: String((b.file as any)?.name ?? "附件") };
    return node;
  }

  if (PLACEHOLDER_KIND[bt]) return { type: "unsupported", unsupportedKind: PLACEHOLDER_KIND[bt] };
  // Anything else unknown → generic placeholder so content never silently vanishes.
  return { type: "unsupported", unsupportedKind: "isv" };
}

/** Build DocNode[] from a flat Feishu block array (skips the root page block). */
export function normalizeBlocks(blocks: unknown[]): DocNode[] {
  const list = blocks as RawBlock[];
  const byId = new Map<string, RawBlock>();
  for (const b of list) if (b?.block_id) byId.set(b.block_id, b);
  const root = list.find((b) => b.block_type === BT.page) ?? list[0];
  const order = root?.children ?? list.filter((b) => b.block_type !== BT.page).map((b) => b.block_id);
  const out: DocNode[] = [];
  walkBlocks(order, byId, out, 0);
  return out;
}

// Walk the block tree depth-first so nested content (sub-lists, container
// children) is never dropped — the docx API returns blocks flat with children
// referenced by id, so iterating only the root's children would lose everything
// nested. List items carry an indent depth; other blocks' children emit inline
// at the same level.
function walkBlocks(
  ids: string[],
  byId: Map<string, RawBlock>,
  out: DocNode[],
  depth: number,
): void {
  for (const id of ids) {
    const b = byId.get(id);
    if (!b || b.block_type === BT.page) continue;
    const node = mapBlock(b);
    const isList = node.type === "bullet" || node.type === "ordered" || node.type === "todo";
    if (isList) node.depth = depth;
    out.push(node);
    if (b.children?.length) walkBlocks(b.children, byId, out, isList ? depth + 1 : depth);
  }
}
