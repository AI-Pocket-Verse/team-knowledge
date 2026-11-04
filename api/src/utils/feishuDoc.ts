// Internal, Feishu-agnostic document model + the Markdown(+HTML) converter.
//
// The converter is a PURE function over DocNode[] — all Feishu-format quirks
// live in feishuNormalize.ts (raw blocks → DocNode[]). This split keeps the
// conversion logic exhaustively unit-testable with hand-written fixtures.

export type Inline =
  | {
      kind: "text";
      text: string;
      bold?: boolean;
      italic?: boolean;
      strike?: boolean;
      code?: boolean;
      underline?: boolean;
      highlight?: boolean;
      link?: string;
    }
  | { kind: "mention"; label: string; url?: string };

export interface DocNode {
  type:
    | "paragraph"
    | "heading"
    | "bullet"
    | "ordered"
    | "todo"
    | "code"
    | "quote"
    | "divider"
    | "image"
    | "table"
    | "unsupported";
  /** heading level 1-9 (rendered capped at 6) */
  level?: number;
  /** todo checked state */
  done?: boolean;
  /** list nesting depth (0 = top level) for bullet/ordered/todo indentation */
  depth?: number;
  /** code block language hint */
  language?: string;
  /** code block raw text */
  text?: string;
  /** inline content for paragraph/heading/list/quote */
  inlines?: Inline[];
  /** image: Feishu media file_token to download + rehost */
  imageToken?: string;
  imageAlt?: string;
  /** table: rows → cells → inline runs */
  table?: { rows: Inline[][][]; complex?: boolean };
  /** unsupported embed kind (bitable/sheet/mindnote/...) — placeholder label */
  unsupportedKind?: string;
  /** A resolvable embed (whiteboard/bitable/sheet/file) — carries the tokens
   *  the route needs to fetch the real content via the Feishu gateway. */
  embed?: EmbedRef;
  /** original Feishu URL for unsupported link-backs */
  sourceUrl?: string;
}

/** Embedded resources we can fetch + render (vs. placeholder-only ones). */
export type EmbedRef =
  | { kind: "whiteboard"; token: string }
  | { kind: "bitable"; appToken: string; tableId: string }
  | { kind: "sheet"; sheetToken: string; sheetId: string }
  | { kind: "file"; token: string; name: string };

export interface ConvertOptions {
  /**
   * How to handle blocks Markdown can't represent (callout/bitable/sheet/…):
   *   "placeholder" → a WYSIWYG-friendly blockquote note + link back to原文
   *   "drop"        → omit entirely (counted in the report)
   * NOT raw HTML — Milkdown (commonmark) renders raw HTML as literal text, so
   * we never emit <div>/<table>; unsupported inline styles (underline/highlight)
   * degrade to plain text for the same reason.
   */
  unsupportedMode: "placeholder" | "drop";
  /** original Feishu doc URL — link target for unsupported blocks */
  sourceUrl: string;
  /** Download + rehost an image; return a local /uploads URL, or null on failure. */
  resolveImage: (fileToken: string, alt?: string) => Promise<string | null>;
  /**
   * Resolve a fetchable embed (whiteboard/bitable/sheet/file) into a Markdown
   * fragment (e.g. an image, a GFM table, or a link). Return null to fall back
   * to the placeholder/drop behavior. The route injects this (it owns the
   * Feishu gateway calls); the converter stays pure + testable with a stub.
   */
  resolveEmbed?: (embed: EmbedRef) => Promise<string | null>;
}

export interface ConversionReport {
  converted: number;
  droppedBlocks: number;
  /** Unsupported blocks rendered as a Markdown placeholder note (+ link). */
  placeholderBlocks: number;
  warnings: string[];
}

const EMBED_LABEL: Record<string, string> = {
  bitable: "多维表格",
  sheet: "电子表格",
  mindnote: "思维笔记",
  board: "画板",
  diagram: "流程图",
  file: "文件附件",
  grid: "分栏",
  callout: "高亮块",
  table: "复杂表格",
  isv: "小组件",
};

// Escape Markdown control chars in plain text runs so doc content can't
// accidentally inject formatting. Links/code are handled separately.
function escapeInline(s: string): string {
  return s.replace(/([\\`*_[\]])/g, "\\$1");
}

// Drop dangerous link schemes (javascript:/data:/vbscript:…) imported from
// arbitrary Feishu link content; keep http(s)/mailto/relative. Defense-in-depth
// against stored-XSS even though the app CSP also blocks javascript: execution.
function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // some other scheme → drop
  return u; // relative / anchor / protocol-relative
}

function renderInlines(inlines: Inline[] | undefined): string {
  if (!inlines) return "";
  return inlines
    .map((el) => {
      if (el.kind === "mention") {
        const u = el.url ? safeUrl(el.url) : null;
        return u ? `[${el.label}](${u})` : el.label;
      }
      if (el.code) return `\`${el.text}\``;
      let t = escapeInline(el.text);
      if (el.bold) t = `**${t}**`;
      if (el.italic) t = `*${t}*`;
      if (el.strike) t = `~~${t}~~`;
      // underline / highlight have no Markdown equivalent the WYSIWYG editor can
      // render → keep the text, drop the styling (emitting <u>/<mark> would show
      // as literal HTML in Milkdown).
      if (el.link) {
        const u = safeUrl(el.link);
        t = u ? `[${t}](${u})` : t;
      }
      return t;
    })
    .join("");
}

// Markdown-native placeholder so the WYSIWYG editor renders it as a real
// blockquote + bold + link — NOT raw HTML shown as literal text (spike 0.1's
// real-browser conclusion: Milkdown/commonmark does not render embedded HTML).
function renderUnsupportedPlaceholder(node: DocNode, fallbackUrl: string): string {
  const label = EMBED_LABEL[node.unsupportedKind ?? ""] ?? "飞书内容";
  const url = node.sourceUrl ?? fallbackUrl;
  return `> 📌 **${label}**(未导入) · [查看原文](${url})`;
}

/**
 * Build a GFM pipe-table from already-stringified cells. First row is the
 * header. Ragged rows are padded to the widest row so the table stays valid.
 * Exported so the import route can turn a bitable/sheet into a table too.
 */
export function buildGfmTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => esc(r[i] ?? ""));
  const head = `| ${pad(rows[0]).join(" | ")} |`;
  const sep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const body = rows
    .slice(1)
    .map((r) => `| ${pad(r).join(" | ")} |`)
    .join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

function renderGfmTable(rows: Inline[][][]): string {
  return buildGfmTable(rows.map((r) => r.map((c) => renderInlines(c))));
}

async function renderNode(
  node: DocNode,
  opts: ConvertOptions,
  report: ConversionReport,
): Promise<string | null> {
  const inl = () => renderInlines(node.inlines);
  switch (node.type) {
    case "heading":
      report.converted++;
      return `${"#".repeat(Math.min(node.level ?? 1, 6))} ${inl()}`;
    case "paragraph":
      report.converted++;
      return inl();
    case "bullet":
      report.converted++;
      return `${"  ".repeat(node.depth ?? 0)}- ${inl()}`;
    case "ordered":
      report.converted++;
      return `${"  ".repeat(node.depth ?? 0)}1. ${inl()}`;
    case "todo":
      report.converted++;
      return `${"  ".repeat(node.depth ?? 0)}- [${node.done ? "x" : " "}] ${inl()}`;
    case "quote":
      report.converted++;
      return `> ${inl()}`;
    case "divider":
      report.converted++;
      return "---";
    case "code": {
      report.converted++;
      // Fence must be longer than any backtick run inside the body, else the
      // code block closes early and leaks content into the document.
      const body = node.text ?? "";
      const longestRun = (body.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      return `${fence}${node.language ?? ""}\n${body}\n${fence}`;
    }
    case "image": {
      const url = node.imageToken ? await opts.resolveImage(node.imageToken, node.imageAlt) : null;
      if (!url) {
        report.warnings.push("图片导入失败");
        return "*（图片导入失败）*";
      }
      report.converted++;
      return `![${node.imageAlt ?? ""}](${url})`;
    }
    case "table": {
      if (node.table && !node.table.complex) {
        report.converted++;
        return renderGfmTable(node.table.rows);
      }
      if (opts.unsupportedMode === "drop") {
        report.droppedBlocks++;
        return null;
      }
      report.placeholderBlocks++;
      return renderUnsupportedPlaceholder({ ...node, unsupportedKind: "table" }, opts.sourceUrl);
    }
    case "unsupported": {
      // A fetchable embed (whiteboard/bitable/sheet/file) → try to resolve it
      // into real Markdown (image / GFM table / link). Fall back to
      // placeholder/drop on miss or failure.
      if (node.embed && opts.resolveEmbed) {
        const md = await opts.resolveEmbed(node.embed);
        if (md != null && md !== "") {
          report.converted++;
          return md;
        }
        // Had a fetchable embed but resolution failed/empty → surface it so a
        // silently-degraded table/board/file isn't mistaken for "no content".
        report.warnings.push(`${EMBED_LABEL[node.unsupportedKind ?? ""] ?? "嵌入"}导入失败,已降级`);
      }
      if (opts.unsupportedMode === "drop") {
        report.droppedBlocks++;
        return null;
      }
      report.placeholderBlocks++;
      return renderUnsupportedPlaceholder(node, opts.sourceUrl);
    }
  }
}

/** Convert an internal DocNode[] into a Markdown string + a conversion report. */
export async function convertDoc(
  nodes: DocNode[],
  opts: ConvertOptions,
): Promise<{ markdown: string; report: ConversionReport }> {
  const report: ConversionReport = { converted: 0, droppedBlocks: 0, placeholderBlocks: 0, warnings: [] };
  const out: string[] = [];
  for (const n of nodes) {
    const rendered = await renderNode(n, opts, report);
    if (rendered !== null && rendered !== undefined) out.push(rendered);
  }
  return { markdown: out.join("\n\n") + "\n", report };
}
