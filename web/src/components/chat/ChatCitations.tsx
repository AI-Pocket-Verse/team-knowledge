import { Link } from "react-router-dom";
import type { CitationRef } from "@team-knowledge/shared";

// Re-export for any consumer that imports under the old name.
export type CitationTarget = CitationRef;

interface Props {
  text: string;
  refs: CitationRef[];
}

export function ChatCitationText({ text, refs }: Props) {
  if (!refs.length) return <>{text}</>;
  const byN = new Map(refs.map((r) => [r.n, r]));
  const parts: Array<string | { ref: CitationTarget; key: string }> = [];
  const re = /\[#(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const n = Number(m[1]);
    const ref = byN.get(n);
    if (ref) parts.push({ ref, key: `c${k++}` });
    else parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <Link
            key={p.key}
            to={`/d/${p.ref.articleId}`}
            title={p.ref.title}
            className="mx-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-fg align-baseline hover:opacity-90"
          >
            #{p.ref.n}
          </Link>
        ),
      )}
    </>
  );
}
