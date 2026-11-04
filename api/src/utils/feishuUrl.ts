export type FeishuLink = { kind: "docx" | "wiki"; token: string };

// Feishu doc tokens are alphanumeric (no slashes/dots). Guards against
// trailing-slash / empty-segment URLs yielding an empty token.
const TOKEN = /^[A-Za-z0-9]+$/;

/**
 * Parse a Feishu / Lark document URL into `{ kind, token }`.
 *
 * v1 supports new-style docx (`/docx/<id>`) and knowledge-base wiki
 * (`/wiki/<node>`) only. Legacy `/docs/`, `/sheets/`, `/base/` etc.
 * return null so the caller can surface "unsupported link".
 */
export function parseFeishuUrl(input: string): FeishuLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/i.test(url.hostname)) return null;
  const segs = url.pathname.split("/").filter(Boolean);
  const idx = segs.findIndex((s) => s === "docx" || s === "wiki");
  if (idx < 0 || idx + 1 >= segs.length) return null;
  const token = segs[idx + 1];
  if (!TOKEN.test(token)) return null;
  return { kind: segs[idx] as "docx" | "wiki", token };
}
