// Pure helpers: turn raw Feishu Bitable / Sheet payloads into string[][] rows
// for buildGfmTable. Bitable field values come in many shapes (text segments,
// option/person objects, attachment arrays, links) — cellText flattens them
// best-effort to a readable string.

export function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text; // text segment
    if (typeof o.name === "string") return o.name; // option / person / attachment
    if (typeof o.en_name === "string") return o.en_name;
    if (typeof o.link === "string") return o.link; // url field
    if (typeof o.value === "string") return o.value;
    if (Array.isArray(o.value)) return cellText(o.value);
    return "";
  }
  return String(v);
}

/** Bitable fields (ordered names) + records (field_name → value map) → table rows. */
export function bitableToRows(
  fieldNames: string[],
  records: Array<Record<string, unknown>>,
  maxRows: number,
): { rows: string[][]; truncated: boolean } {
  const truncated = records.length > maxRows;
  const body = records.slice(0, maxRows).map((rec) => fieldNames.map((fn) => cellText(rec[fn])));
  return { rows: [fieldNames, ...body], truncated };
}

/** Sheet cell-value matrix → table rows, dropping fully-empty trailing rows. */
export function sheetToRows(values: unknown[][]): string[][] {
  const rows = values.map((row) => row.map(cellText));
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

// Recognizes the opening keyword of a Mermaid diagram source.
const MERMAID_RE =
  /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart)\b/;

/**
 * Best-effort: find a Mermaid diagram source among whiteboard nodes. A board
 * drawn with the diagram-syntax tool carries the raw source in a node field;
 * freehand boards won't match → returns null (caller falls back to an image).
 */
export function extractMermaid(nodes: Array<Record<string, unknown>>): string | null {
  for (const node of nodes) {
    for (const v of Object.values(node)) {
      if (typeof v === "string" && MERMAID_RE.test(v)) return v.trim();
      if (v && typeof v === "object") {
        for (const inner of Object.values(v as Record<string, unknown>)) {
          if (typeof inner === "string" && MERMAID_RE.test(inner)) return inner.trim();
        }
      }
    }
  }
  return null;
}
