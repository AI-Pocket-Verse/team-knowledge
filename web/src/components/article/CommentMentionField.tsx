import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";

// Comment composer with inline @-mention of users. It's a contentEditable
// (not a textarea) so a picked mention renders as a BLUE chip — `@姓名` — while
// you type, instead of the raw `[@姓名](/u/id)` markdown. On the way out the
// chips serialize back to that markdown marker, which the backend parses into
// CommentMention rows + a comment_mention notification (unchanged contract).
// Mirrors the chat composer's chip mechanics (ChatComposer.tsx).

export interface CommentFieldHandle {
  focus: () => void;
  clear: () => void;
}

interface MentionUser { id: string; displayName: string; avatarUrl: string | null }

// ── pure-ish DOM helpers (exported for tests) ────────────────────────────────

// 显示名里的 `\` `[` `]` `(` `)` 序列化时用反斜杠转义,解析时 `\.` 整体吞掉,
// 所以名字里的 `]` 不会提前结束标记。历史数据(未转义、不含反斜杠)解析结果不变。
// 后端同一规则见 api/src/utils/notify/mentions.ts。
const NAME_SRC = String.raw`(?:\\.|[^\]\\])+`;
const ID_SRC = String.raw`[A-Za-z0-9_-]+`;
const MENTION_SPLIT = new RegExp(String.raw`(\[@${NAME_SRC}\]\(\/u\/${ID_SRC}\))`);
const MENTION_ONE = new RegExp(String.raw`^\[@(${NAME_SRC})\]\(\/u\/${ID_SRC}\)$`);

export const escapeMentionName = (name: string) => name.replace(/[\\[\]()]/g, "\\$&");
const unescapeMentionName = (name: string) => name.replace(/\\(.)/g, "$1");

/** 提及标记 `[@name](/u/id)` 还原成 `@name`(显示名去转义),供计数与引用摘要使用。 */
export function mentionsToPlain(body: string): string {
  return body.replace(new RegExp(String.raw`\[@(${NAME_SRC})\]\(\/u\/${ID_SRC}\)`, "g"), (_m, name: string) => `@${unescapeMentionName(name)}`);
}

/** Render a posted comment body: `[@name](/u/id)` markers → blue @name spans. */
export function renderCommentBody(body: string): ReactNode[] {
  return body.split(MENTION_SPLIT).map((seg, i) => {
    const m = seg.match(MENTION_ONE);
    if (m) return <span key={i} className="font-medium text-primary">@{unescapeMentionName(m[1] ?? "")}</span>;
    return <span key={i}>{seg}</span>;
  });
}

/** Serialize the editor DOM to markdown: text as-is, chips → [@name](/u/id). */
export function serializeEditor(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.dataset.uid && node.dataset.uname) {
        parts.push(`[@${escapeMentionName(node.dataset.uname)}](/u/${node.dataset.uid})`);
        return;
      }
      if (node.nodeName === "BR") {
        parts.push("\n");
        return;
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return parts.join("");
}

function isEmpty(root: HTMLElement): boolean {
  return (root.textContent ?? "").trim().length === 0 && !root.querySelector("[data-uid]");
}

interface Trigger { query: string; range: Range }

// Caret sits right after a `@<query>` run (no whitespace/second @) → return the
// query + a Range over the trigger chars so we can splice in the chip.
function detectTrigger(root: HTMLElement): Trigger | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const before = (node.textContent ?? "").slice(0, range.startOffset);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) return null;
  const start = before.length - m[0].length;
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, range.startOffset);
  return { query: m[1] ?? "", range: r };
}

// ── component ────────────────────────────────────────────────────────────────

interface Props {
  onChange: (markdown: string) => void;
  onSubmitShortcut?: () => void;
  placeholder?: string;
  className?: string;
}

export const CommentMentionField = forwardRef<CommentFieldHandle, Props>(function CommentMentionField(
  { onChange, onSubmitShortcut, placeholder, className },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [results, setResults] = useState<MentionUser[]>([]);
  const [active, setActive] = useState(0);
  const query = trigger?.query ?? null;

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    clear: () => {
      if (editorRef.current) editorRef.current.innerHTML = "";
      onChange("");
      setTrigger(null);
    },
  }), [onChange]);

  // Search (debounced) once the query is ≥2 chars — the endpoint's minimum.
  // includeSelf so typing your own name returns a result.
  useEffect(() => {
    if (query === null || query.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      api.searchUsers(query, true)
        .then((r) => { if (!cancelled) { setResults(r.users); setActive(0); } })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query]);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    // A backspaced-empty contentEditable leaves a stray <br>; reset so the
    // :empty placeholder reappears and serialize reports a true "".
    if (isEmpty(el) && el.innerHTML !== "") el.innerHTML = "";
    onChange(serializeEditor(el));
  }, [onChange]);

  const composingRef = useRef(false);

  function syncAfterInput() {
    const el = editorRef.current;
    if (!el) return;
    emitChange();
    setTrigger(detectTrigger(el));
  }

  // Skip state work DURING IME composition (pinyin): re-rendering on each
  // composition keystroke disrupts the in-flight composition and can duplicate
  // / strand the first character typed after a chip. Sync once it commits.
  function handleInput() {
    if (composingRef.current) return;
    syncAfterInput();
  }

  function pick(u: MentionUser) {
    const el = editorRef.current;
    if (!el) return;
    // Re-derive from the LIVE caret — the stored range can be stale if the user
    // typed more after the popover opened (otherwise the chip splices at the
    // wrong spot / leaves a dangling @query fragment).
    const t = detectTrigger(el) ?? trigger;
    if (!t) return;
    t.range.deleteContents();
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.className = "tm-mention-chip";
    chip.dataset.uid = u.id;
    chip.dataset.uname = u.displayName;
    chip.textContent = `@${u.displayName}`;
    t.range.insertNode(chip);
    const space = document.createTextNode(" ");
    chip.after(space);
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      // Caret INSIDE the trailing space text node (not at the element boundary
      // after it) so the next character appends cleanly, instead of the browser
      // duplicating the first keystroke after the atomic chip.
      r.setStart(space, space.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    setTrigger(null);
    setResults([]);
    emitChange();
    el.focus();
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (trigger && results.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % results.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); return; }
      if (e.key === "Enter") { e.preventDefault(); pick(results[active] ?? results[0]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setTrigger(null); return; }
    }
    // Atomic chip backspace: caret right after a chip removes the whole chip.
    if (e.key === "Backspace" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const offset = range.startOffset;
        let prevChip: HTMLElement | null = null;
        if (node.nodeType === Node.TEXT_NODE && offset === 0) {
          let prev = node.previousSibling;
          while (prev && prev.nodeType === Node.TEXT_NODE && (prev.textContent ?? "").length === 0) prev = prev.previousSibling;
          if (prev instanceof HTMLElement && prev.dataset.uid) prevChip = prev;
        } else if (node === editorRef.current && offset > 0) {
          const c = editorRef.current?.childNodes[offset - 1];
          if (c instanceof HTMLElement && c.dataset.uid) prevChip = c;
        }
        if (prevChip) { e.preventDefault(); prevChip.remove(); emitChange(); return; }
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onSubmitShortcut?.(); }
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) document.execCommand?.("insertText", false, text);
    emitChange();
  }

  return (
    <div className="relative">
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKey}
        onPaste={handlePaste}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; syncAfterInput(); }}
        data-placeholder={placeholder}
        className={`tm-chat-editor overflow-y-auto whitespace-pre-wrap break-words ${className ?? ""}`}
      />
      {trigger && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-auto rounded-lg border border-line bg-white py-1 shadow-pop">
          {query !== null && query.length < 2 ? (
            <div className="px-3 py-2 text-xs text-muted">输入姓名以 @ 提及…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">无匹配姓名</div>
          ) : (
            results.map((u, i) => (
              <button
                key={u.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(u); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === active ? "bg-blue-50 text-primary" : "hover:bg-blue-50/40"}`}
              >
                {u.avatarUrl ? (
                  <img src={u.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700">
                    {u.displayName.slice(0, 1)}
                  </span>
                )}
                <span className="truncate">{u.displayName}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
});
