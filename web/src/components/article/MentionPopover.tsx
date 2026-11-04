import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArticleSearchHit } from "@team-knowledge/shared";

interface Props {
  query: string;
  anchor: { left: number; top: number };
  onSelect: (hit: ArticleSearchHit) => void;
  onClose: () => void;
  search: (q: string) => Promise<ArticleSearchHit[]>;
}

export function MentionPopover({ query, anchor, onSelect, onClose, search }: Props) {
  const [hits, setHits] = useState<ArticleSearchHit[]>([]);
  const [active, setActive] = useState(0);
  // True from the moment a non-empty query is typed until its debounced
  // search resolves. Lets the Enter handler distinguish "no matches" from
  // "results haven't arrived yet" so a fast Enter doesn't prematurely close
  // the popover (and drop the mention) before the search lands.
  const [searching, setSearching] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHits([]);  // immediately clear stale results when query changes
    if (query.length === 0) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      search(query).then((r) => {
        if (cancelled) return;
        setHits(r);
        setActive(0);
      }).catch(() => setHits([])).finally(() => {
        if (!cancelled) setSearching(false);
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, search]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Tab") { onClose(); return; }
      if (hits.length === 0) {
        // A search is still in flight (debounce pending or fetch running):
        // swallow Enter so it neither closes the popover nor inserts a
        // newline — the user is waiting on results that haven't arrived.
        if (e.key === "Enter" && searching) { e.preventDefault(); return; }
        if (e.key === "Enter") onClose();
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % hits.length); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive((i) => (i - 1 + hits.length) % hits.length); }
      if (e.key === "Enter")     {
        e.preventDefault();
        const hit = hits[active] ?? hits[0];
        if (hit) onSelect(hit);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hits, active, onSelect, onClose, searching]);

  useEffect(() => {
    function onOutside(e: MouseEvent | TouchEvent) {
      const node = ref.current;
      if (node && !node.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [onClose]);

  if (hits.length === 0 && query.length === 0) return null;

  return createPortal(
    <div
      ref={ref}
      role="listbox"
      className="fixed z-50 min-w-64 rounded-xl border border-line bg-white py-1 shadow-glassLg"
      style={{ left: anchor.left, top: anchor.top + 4 }}
    >
      {hits.length === 0 ? (
        <div className="px-3 py-2 text-sm text-muted">无匹配结果</div>
      ) : (
        hits.map((h, i) => (
          <button
            key={h.id}
            type="button"
            onClick={() => onSelect(h)}
            className={
              "block w-full text-left px-3 py-2 text-sm " +
              (i === active ? "bg-blue-50 text-primary" : "hover:bg-blue-50/40")
            }
          >
            <div className="font-medium">{h.title}</div>
            <div className="text-xs text-muted">{h.roleName} / {h.folderName}</div>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
