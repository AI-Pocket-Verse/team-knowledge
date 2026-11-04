import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/atom-one-dark.css";
import type { CitationRef } from "@team-knowledge/shared";

// Per-bubble code highlighter. `lib/common` ships ~35 of the most-
// used languages (TS, JS, Python, Go, Rust, SQL, Bash, JSON, YAML,
// HTML, CSS, …) at ~25KB gz — covers everything a knowledge-base
// assistant typically produces without dragging in highlight.js's
// full 192-language tree (~250KB+).
//
// `highlightAuto` is the fallback when the fence has no language
// tag; it scans the code against all registered languages and picks
// the best match. Worst case it produces a single `.hljs` wrapper
// span with no inner highlighting — i.e. the code stays readable
// even when detection fails.
//
// hljs ESCAPES the input before tokenizing, so even though we render
// its output via dangerouslySetInnerHTML the code's raw `<` `>` `&`
// can't escape into the DOM.
function highlightCode(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    // Defensive: an unexpected throw shouldn't break the message
    // render. Fall back to plain (escaped) text.
    return code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

// Lightweight markdown renderer scoped to AI chat bubbles. We
// intentionally do NOT pull in `react-markdown` / `marked` here —
// the AI's typical output is a handful of paragraphs, lists, bold
// emphasis, fenced code, and `[#N]` citations, all of which fit a
// ~120-line custom renderer. Avoiding a full md library keeps the
// chat bundle small and the rendering pipeline deterministic.
//
// Streaming-safe: unmatched markers (`**foo` with no closing pair
// while the assistant is mid-stream) fall through as literal text
// instead of swallowing the half-written content. So you watch
// **bold** materialize cleanly as the stream catches up.

interface Props {
  text: string;
  refs: CitationRef[];
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; content: string }
  | { kind: "quote"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "hr" };

const BLOCK_START = /^(```|>|#{1,6}\s|[-*+]\s|\d+\.\s|---\s*$|___\s*$)/;

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code (```lang ... ```)
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      // Skip closing fence (or, if the stream hasn't yet emitted it,
      // we still produce a code block — caller sees the partial body
      // formatted, no half-written ` characters leaking through).
      if (i < lines.length) i++;
      out.push({ kind: "code", lang, content: buf.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^(---|___|\*\*\*)\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    // Heading (#, ##, …, ######)
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // Blockquote — consume consecutive `> ` lines.
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", items });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — consume until blank or next block-level marker.
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !BLOCK_START.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ kind: "p", text: buf.join("\n") });
  }
  return out;
}

// Inline markers we recognize, in priority order. `code` wins
// against `bold`/`italic` so a backtick span can hold `*` literally.
// `bold` (`**`) must precede `italic` (`*`) so we don't accidentally
// open italics from the first `*` of a `**` pair.
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[#(\d+)\])|(\[([^\]]+)\]\(([^)\s]+)\))/g;

// Gate markdown link targets before they ever reach an <a href>. The
// AI's output is untrusted: a `[click](javascript:alert(1))` link would
// otherwise execute JS in the user's authenticated session on click.
// INLINE_RE's URL group is paren/space-free, so a scheme-bearing
// `javascript:`/`vbscript:`/`data:` URL slips through the pattern — we
// must validate the SCHEME here, not in the regex. Allow only:
//   - http: / https: / mailto: (explicit safe schemes)
//   - root-relative / fragment / relative paths (no scheme at all:
//     "/d/x", "#sec", "foo/bar") — these can't carry an executable
//     scheme and stay inside the app.
// Anything else (any other `scheme:` prefix) → null, and the caller
// renders the link as plain label text instead of a clickable anchor.
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;
  // 浏览器解析 URL 前会剥掉前导的 C0 控制字符、并忽略其中的制表符/换行，所以
  // "\u0001javascript:..." 在这里匹配不到 scheme、到浏览器却是 javascript:。
  // 含任何控制字符/空白，或反斜杠("/\\evil.com" 会被当成协议相对地址)的目标一律拒绝。
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(url)) return null;
  // A leading "scheme:" (RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ))
  // marks an absolute URL. If present, only allow our explicit allowlist.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    return s === "http" || s === "https" || s === "mailto" ? url : null;
  }
  // No scheme → relative / root / fragment path. Reject protocol-relative
  // "//evil.com" (browsers resolve it to https://evil.com, defeating the
  // intent of "no scheme"). Everything else is in-app and safe.
  if (url.startsWith("//")) return null;
  return url;
}

function renderInline(text: string, byN: Map<number, CitationRef>, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  // Fresh regex per call — globally-stateful `lastIndex` would
  // corrupt streaming re-renders.
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${k++}`;
    if (m[1]) {
      out.push(
        <code
          key={key}
          className="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[0.85em] text-fg"
        >
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <strong key={key} className="font-semibold">
          {m[2].slice(2, -2)}
        </strong>,
      );
    } else if (m[3]) {
      out.push(
        <em key={key} className="italic">
          {m[3].slice(1, -1)}
        </em>,
      );
    } else if (m[4]) {
      const n = Number(m[5]);
      const ref = byN.get(n);
      if (ref) {
        out.push(
          <Link
            key={key}
            to={`/d/${ref.articleId}`}
            title={ref.title}
            className="mx-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-fg align-baseline hover:opacity-90"
          >
            #{ref.n}
          </Link>,
        );
      } else {
        out.push(m[4]);
      }
    } else if (m[6]) {
      const safe = safeUrl(m[8]);
      if (safe) {
        out.push(
          <a
            key={key}
            href={safe}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {m[7]}
          </a>,
        );
      } else {
        // Unsafe scheme (javascript:/data:/…). Drop the href entirely
        // and render just the label so the content is preserved without
        // an executable link.
        out.push(m[7]);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ChatMarkdown({ text, refs }: Props) {
  const byN = new Map(refs.map((r) => [r.n, r]));
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2.5 text-[15px] leading-[1.74] text-fg">
      {blocks.map((b, idx) => {
        const k = `b${idx}`;
        switch (b.kind) {
          case "p":
            return (
              <p key={k} className="whitespace-pre-wrap break-words">
                {renderInline(b.text, byN, k)}
              </p>
            );
          case "heading": {
            const cls =
              b.level <= 2
                ? "text-[17px] font-semibold text-fg"
                : b.level === 3
                ? "text-[15px] font-semibold text-fg"
                : "text-[15px] font-medium text-fg";
            // Render every level as the same visual weight tier (small)
            // so a `# H1` in a 250-char chat bubble doesn't blow out the
            // bubble width. The level distinction still exists semantically.
            return (
              <div key={k} className={cls}>
                {renderInline(b.text, byN, k)}
              </div>
            );
          }
          case "code":
            return (
              <pre
                key={k}
                className="overflow-x-auto rounded-lg bg-[#282c34] px-3 py-2 text-[0.78rem] leading-relaxed"
              >
                {/* `hljs` className activates atom-one-dark theme. The
                    output of highlightCode is escaped + wrapped in
                    span.hljs-* tokens, safe to inject as HTML. */}
                <code
                  className={`hljs ${b.lang ? `language-${b.lang}` : ""}`.trim()}
                  dangerouslySetInnerHTML={{ __html: highlightCode(b.content, b.lang) }}
                />
              </pre>
            );
          case "quote":
            return (
              <blockquote
                key={k}
                className="rounded-r-md border-l-[3px] border-line bg-surface py-1.5 pl-3 pr-2 text-muted"
              >
                {renderInline(b.text, byN, k)}
              </blockquote>
            );
          case "ul":
            // pl-4 (16px) + marker:pr-0 + no inter-item gap. AI lists
            // in a chat bubble are usually short and tight; the
            // earlier pl-5 / space-y-0.5 wasted vertical space and
            // pushed the bullet marker further out than the bubble
            // padding warrants.
            return (
              <ul key={k} className="list-disc pl-4 [&>li]:my-0 [&>li]:pl-0.5">
                {b.items.map((it, j) => (
                  <li key={`${k}-${j}`}>{renderInline(it, byN, `${k}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} className="list-decimal pl-5 [&>li]:my-0 [&>li]:pl-0.5">
                {b.items.map((it, j) => (
                  <li key={`${k}-${j}`}>{renderInline(it, byN, `${k}-${j}`)}</li>
                ))}
              </ol>
            );
          case "hr":
            return <hr key={k} className="border-line" />;
          default:
            return <Fragment key={k} />;
        }
      })}
    </div>
  );
}
