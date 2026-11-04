import { useCallback, useEffect, useRef, useState } from "react";
import { parseClipboardHtml } from "./parseClipboardHtml";
import { Crepe } from "@milkdown/crepe";
import { commandsCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, prosePluginsCtx, schemaCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import {
  clearTextInCurrentBlockCommand,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand,
} from "@milkdown/preset-commonmark";
import { DOMParser as PMDOMParser, Fragment as PMFragment, type Node as PMNode, type Schema as PMSchema, Slice as PMSlice } from "prosemirror-model";
import { createTable } from "@milkdown/preset-gfm";
import { NodeSelection, Plugin as PMPlugin, Selection as PMSelection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { MentionPopover } from "./MentionPopover";
import { fileAttachmentPlugins, FILE_ATTACHMENT_ID, openableUploadUrl } from "./fileAttachment";
import { uploadSrc, uploadsToDisplay, uploadsToStorage } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import type { ArticleSearchHit } from "@team-knowledge/shared";
import "./milkdown.css";
import { tr, type MessageKey } from "@/i18n";

// Lazy-loaded mermaid renderer for ```mermaid code blocks (Feishu whiteboards
// drawn with diagram syntax import as mermaid; any mermaid block renders too).
// Dynamic import keeps mermaid (~MBs) out of the main editor bundle. Returns
// the SVG STRING — Crepe's renderPreview is async only when we return undefined
// and feed the result via applyPreview (returning an HTMLElement is treated as
// sync and snapshots it empty before mermaid resolves). mermaid is initialized
// once (idempotent global config).
let mermaidMod: Promise<typeof import("mermaid")> | null = null;
let mermaidReady = false;
let mermaidSeq = 0;
async function renderMermaidToSvg(code: string, seq: number): Promise<string> {
  mermaidMod ??= import("mermaid");
  const mermaid = (await mermaidMod).default;
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    mermaidReady = true;
  }
  const { svg } = await mermaid.render("mmd-" + seq, code);
  return svg;
}

// Inline SVG icons for the bubble-toolbar additions. Crepe's `icons/*`
// files aren't re-exported via the package.json `exports`, so we ship
// our own small set. 20×20 viewBox keeps them visually aligned with
// Crepe's built-in 24×24 mark icons after the Toolbar's 4px padding.
const headingSvg = (label: string) =>
  // `dominant-baseline: central` + y=50% reliably vertically centers the H1-H6
  // label across browsers (plain `middle` sits the text ~1px low in some).
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif,system-ui" font-size="11" font-weight="700">${label}</text></svg>`;
const ICON_H1 = headingSvg("H1");
const ICON_H2 = headingSvg("H2");
const ICON_H3 = headingSvg("H3");
const ICON_H4 = headingSvg("H4");
const ICON_H5 = headingSvg("H5");
const ICON_H6 = headingSvg("H6");
const ICON_QUOTE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h4v4H8c0 2 1 3 3 3v2c-3 0-5-2-5-5V7zm9 0h4v4h-3c0 2 1 3 3 3v2c-3 0-5-2-5-5V7z"/></svg>`;
// Slash-menu icons for our custom items. CRITICAL: these are FILLED
// SVGs (single `<path>` with implicit fill), NOT outline / stroked.
// Crepe's slash-menu CSS targets the icon SVG with
// `fill: var(--crepe-color-outline)` (see block-edit.css). An outline
// icon with `stroke="currentColor" fill="none"` ends up invisible —
// the CSS-set fill has nothing to paint (path is hollow) and the
// stroke attribute isn't styled by Crepe. Drawing as a single filled
// path matches Crepe's own glyphs (image.ts, table.ts, etc.) and
// inherits the correct color without extra rules.
const ICON_ATTACHMENT = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>`;
const ICON_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.9 13.98l2.1 2.53 3.1-3.99L18 18H6l2.9-4.02zM10.5 9.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5S8.17 8 9 8s1.5.67 1.5 1.5z"/></svg>`;
const ICON_TABLE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 3v18h18V3H3zm6 16H5v-4h4v4zm0-6H5V9h4v4zm0-6H5V5h4v2zm6 12h-4v-4h4v4zm0-6h-4V9h4v4zm0-6h-4V5h4v2zm6 12h-4v-4h4v4zm0-6h-4V9h4v4zm0-6h-4V5h4v2z"/></svg>`;
const ICON_MATH = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18 4H6v2l6.5 6L6 18v2h12v-3h-7l5-5-5-5h7z"/></svg>`;

// 顶栏(Crepe TopBar)按钮的中文 tooltip。Crepe 的 TopBarItem 配置没有
// title 字段,渲染出的 <button.top-bar-item> 也不带任何 per-item 标识,
// 所以只能按「渲染顺序」映射。顺序对应 @milkdown/crepe top-bar 的
// getGroups():formatting(粗体/斜体/删除线/行内代码)→ list(无序/有序/
// 任务)→ insert(链接/图片/表格)→ block(代码块/公式)→ more(引用/
// 分割线),末尾追加我们在 buildTopBar 里加的「上传文件」。image/table/math
// 三项仅在对应 feature 开启时出现——本编辑器三者都开,故固定 15 项;若将来
// 禁用某个 feature 导致按钮数量对不上,applyTopBarTitles 会整体跳过(宁可
// 没 tooltip 也不贴错名)。
const TOP_BAR_ITEM_TITLES: readonly MessageKey[] = [
  "article.editor.topbar.bold", "article.editor.topbar.italic", "article.editor.topbar.strike", "article.editor.topbar.code",
  "article.editor.topbar.bullet", "article.editor.topbar.ordered", "article.editor.topbar.task",
  "article.editor.topbar.link", "article.editor.topbar.image", "article.editor.topbar.table",
  "article.editor.topbar.codeBlock", "article.editor.topbar.math",
  "article.editor.topbar.quote", "article.editor.topbar.hr",
  "article.editor.topbar.upload",
];

// 给顶栏按钮补 title(中文名)。仅当按钮数量与预期完全一致时才逐个贴,
// 数量不符则跳过(见上方说明)。标题下拉按钮单独贴「标题级别」。
function applyTopBarTitles(topbar: HTMLElement): void {
  const buttons = topbar.querySelectorAll<HTMLElement>(".top-bar-item");
  if (buttons.length === TOP_BAR_ITEM_TITLES.length) {
    buttons.forEach((btn, i) => {
      const name = TOP_BAR_ITEM_TITLES[i];
      if (name) btn.title = tr(name);
    });
  }
  const heading = topbar.querySelector<HTMLElement>(".top-bar-heading-button");
  if (heading) heading.title = tr("article.editor.headingLevel");
}

// Walk a pasted slice and split every paragraph at hard-break nodes,
// turning a single paragraph that contained `<br>` line breaks into
// multiple sibling paragraphs. Wired into `transformPasted` so this
// runs after PMDOMParser produces the slice and before it's inserted.
//
// Why: Milkdown's `hardbreakClearMarkPlugin` deliberately strips marks
// from hard-break nodes (so Bold can't span across a `<br>`). When the
// user then toggles a mark across a multi-line paragraph, the
// serializer emits a chain of separately-marked spans with `\` line
// endings, which round-trips into either 3 stacked paragraphs or a
// space-joined single line depending on parser quirks. By converting
// `<br>`-split lines to actual sibling paragraphs at paste time, mark
// toggling stays scoped to each individual paragraph — no surprise
// structural reshuffle later.
//
// We only split top-level paragraphs (don't recurse into list items
// or blockquote children) — that's the only context the bug surfaced
// in, and recursing would slow paste of large rich HTML clipboards
// without an obvious user benefit.
function splitParagraphsAtHardBreaks(slice: PMSlice, schema: PMSchema): PMSlice {
  const hbType = schema.nodes.hardbreak;
  const pType = schema.nodes.paragraph;
  if (!hbType || !pType) return slice;
  const out: PMNode[] = [];
  let anySplit = false;
  slice.content.forEach((node) => {
    if (node.type !== pType) {
      out.push(node);
      return;
    }
    // Collect children, breaking the run on each hard-break we hit.
    const segments: PMNode[][] = [[]];
    let foundHb = false;
    node.content.forEach((child) => {
      if (child.type === hbType) {
        foundHb = true;
        segments.push([]);
      } else {
        segments[segments.length - 1]!.push(child);
      }
    });
    if (!foundHb) {
      out.push(node);
      return;
    }
    anySplit = true;
    // Drop wholly-empty segments (leading / trailing `<br>` or `<br><br>`),
    // wrap the rest as fresh paragraphs preserving the source paragraph's
    // attrs (textAlign etc., when applicable).
    for (const seg of segments) {
      if (seg.length === 0) continue;
      out.push(pType.create(node.attrs, PMFragment.from(seg)));
    }
  });
  if (!anySplit) return slice;
  return new PMSlice(PMFragment.from(out), slice.openStart, slice.openEnd);
}

// "Insert at cursor, but if the cursor sits in an empty textblock,
// REPLACE that block instead." Used by every custom slash-menu item
// (Image / Table / Math) so they land on the user's current empty
// line rather than leaving a stray blank above the inserted node
// the way Crepe's default `addBlockTypeCommand` does.
function insertBlockInPlace(ctx: Ctx, node: PMNode): void {
  const view = ctx.get(editorViewCtx);
  const { $from } = view.state.selection;
  const parent = $from.parent;
  const tr = view.state.tr;
  if (parent.isTextblock && parent.content.size === 0) {
    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    tr.replaceRangeWith(from, to, node);
    // Atom block (image-block) replacing the only empty paragraph
    // leaves ProseMirror with nowhere to park a TextSelection cursor.
    // If we don't explicitly NodeSelect the new atom, ProseMirror or
    // the schema's auto-fill rules grow a trailing empty paragraph
    // below it just to host a cursor — which the user sees as a
    // stray blank line after their inserted image. Selecting the
    // atom itself satisfies the selection invariant without growing
    // the doc. Non-atom inserts (table) keep the default cursor
    // mapping; they have textblock children to receive the caret.
    if (node.type.spec.selectable && node.type.isAtom) {
      tr.setSelection(NodeSelection.create(tr.doc, from));
    }
  } else {
    tr.replaceSelectionWith(node);
  }
  view.dispatch(tr);
}

// Open the OS file picker and resolve with the chosen File (or null if
// the user cancels). Native pickers don't reliably emit a "cancel"
// event so this resolves on `change` and stays pending on cancel;
// callers should always race it with the user's next action.
function openFilePicker(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    let settled = false;
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.display = "none";

    let cancelTimer: number | undefined;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      if (cancelTimer !== undefined) window.clearTimeout(cancelTimer);
      input.remove();
      window.removeEventListener("focus", onFocus);
      resolve(file);
    };
    // `change` is the AUTHORITATIVE signal a file was picked — resolve from it
    // immediately and unconditionally so a real selection is never dropped.
    input.addEventListener("change", () => {
      finish(input.files?.[0] ?? null);
    });
    // Native file pickers don't emit a cancel event, so a
    // Promise that only resolves on `change` would leak when the user dismisses
    // the dialog. Detect cancel by listening for the window regaining focus.
    //
    // The cancel timer used to be 400ms, but on slow systems / mobile
    // Safari the genuine `change` event can arrive AFTER focus returns, so the
    // picked file was silently lost. Use a much longer window (2.5s): if the
    // input still has no file by then, it's a real cancel; otherwise `change`
    // has fired (or will, settling via finish above) and `input.files` is set,
    // so we resolve with that file rather than null.
    const onFocus = () => {
      cancelTimer = window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 2500);
    };
    window.addEventListener("focus", onFocus, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

interface MilkdownEditorProps {
  initialMarkdown: string;
  readOnly?: boolean;
  onChange?: (markdown: string) => void;
  // 编辑器创建完成后回调一次:返回编辑器对 initialMarkdown 做 parse→serialize 归一化
  // 后的实际内容。调用方据此把「基线」对齐到归一化结果,避免「加载即变脏」(归一化与原始
  // markdown 的微小出入被误判为用户编辑,从而触发「未保存修改」拦截弹窗)。
  onReady?: (markdown: string) => void;
  onPasteImage?: (file: File) => Promise<string>;
  // Generic file attachment uploader. Returns the URL + the filename
  // we should show to the user in the markdown link text. Triggered by
  // paste / drag-drop of any non-image file.
  onPasteFile?: (file: File) => Promise<{ url: string; displayName: string }>;
  onMentionQuery?: (query: string) => Promise<ArticleSearchHit[]>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The display text inside an attachment link: 📎 + 原始文件名(含后缀)+
// 人类可读大小,如 `📎 方案.pdf (1.2 MB)`。保持纯文本(不转义 markdown),
// 因为它进的是 ProseMirror 文本节点,不是 markdown 源码串。
function attachmentLabel(displayName: string, bytes: number): string {
  return `📎 ${displayName} (${formatBytes(bytes)})`;
}

// 在光标处插入一个「附件原子卡片」节点(file-attachment,见 fileAttachment.ts)。
//
// 为什么不能用 `insertText("[label](url)")`:insertText 插入的是【纯文本
// 字符】。commonmark 只给 emphasis/heading/... 这类「打字触发」的 input
// rule,链接 `[x](y)` 没有 input rule,程序化插入也不触发任何 input rule,
// 于是就以字面 markdown 留下;更糟的是保存时序列化器会把方括号转义,所以
// 即便重载也不会变成链接——这正是「文件 chip 显示成 `[📎 name (size)](url)`
// 文本」的 bug。直接创建原子节点会立刻生成不可编辑的 <a> 卡片(→ 命中 chip
// 样式、可点击预览、删除整块),且 parse↔serialize 稳定往返为 markdown 链接。
function insertAttachmentLink(view: EditorView, displayName: string, url: string, bytes: number): void {
  const { schema } = view.state;
  const nodeType = schema.nodes[FILE_ATTACHMENT_ID];
  // 编辑器内一律用显示形态(带 BASE_URL 前缀)的地址,点击才打得开;
  // 序列化回存储时由 markdownUpdated 的 uploadsToStorage 统一剥回 /uploads/*。
  const href = uploadSrc(url);
  if (!nodeType) {
    // 兜底:节点已在 create() 前注册,理论上不会走到这;退化为纯文本不丢地址。
    view.dispatch(view.state.tr.insertText(attachmentLabel(displayName, bytes)));
    return;
  }
  const node = nodeType.create({ src: href, name: displayName, size: formatBytes(bytes) });
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
}

interface MentionState {
  query: string;
  anchor: { left: number; top: number };
  start: number;
}

// Anything larger than this in a single paste triggers a confirm dialog,
// because >500 KB of synchronous ProseMirror processing can freeze the UI
// for several hundred ms on slower machines.
const LARGE_PASTE_THRESHOLD = 500_000;

/**
 * Replace every <img src="data:..."> inside `root` with an uploaded URL.
 * Mutates `root` in place. Skips non-base64 srcs untouched. Failed uploads
 * become `[图片上传失败]` placeholders so the rest of the paste still lands.
 */
async function transcodeBase64Images(
  root: HTMLElement,
  upload: (file: File) => Promise<string>,
): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || !src.startsWith("data:image/")) continue;
    try {
      const blob = await (await fetch(src)).blob();
      const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const file = new File([blob], `pasted.${ext}`, { type: blob.type });
      const url = await upload(file);
      img.setAttribute("src", uploadSrc(url));
    } catch {
      const placeholder = document.createTextNode(tr("article.editor.imageUploadFailedMark"));
      img.replaceWith(placeholder);
    }
  }
}

/** Insert an HTML fragment into the editor as ProseMirror nodes. */
function insertHtmlAtCursor(view: EditorView, html: string): void {
  const div = parseClipboardHtml(html);
  // 粘贴的 HTML 可能携带存储形态的 /uploads/* 地址(如从我们自己渲染的
  // 文章复制)——进编辑器前补前缀,否则图裂/链接 404。
  for (const img of Array.from(div.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", uploadSrc(src));
  }
  for (const a of Array.from(div.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    if (href) a.setAttribute("href", uploadSrc(href));
  }
  const parser = PMDOMParser.fromSchema(view.state.schema);
  const slice = parser.parseSlice(div);
  view.dispatch(view.state.tr.replaceSelection(slice));
}

// Block-level markdown signals only — line-start headings, fenced
// code, lists, blockquotes, table rows. Used in contexts where a
// false positive is expensive (overriding the IDE's content-type or
// ignoring a rich-HTML clipboard payload). Excludes inline `[link]()`
// and `![img]()` patterns, which occur naturally inside source code
// (e.g. JS index access `arr[0](x)`).
const STRUCTURAL_MD_PATTERNS: ReadonlyArray<RegExp> = [
  /^#{1,6}\s+\S/m,        // # heading
  /^```/m,                 // ``` code fence
  /^\s*[-*+]\s+\S/m,       // bullet list
  /^\s*\d+\.\s+\S/m,       // ordered list
  /^>\s+\S/m,              // > blockquote
  /^\|.*\|/m,              // | table row |
];

export function looksLikeStructuralMarkdown(text: string): boolean {
  if (!text) return false;
  return STRUCTURAL_MD_PATTERNS.some((re) => re.test(text));
}

// Heuristic: does `text` carry any markdown syntax — structural OR
// inline (links / images)? Looser than `looksLikeStructuralMarkdown`.
// Useful when we already know the clipboard isn't code (e.g. text-only
// paste from a terminal), and want to catch one-liners like
// `see [docs](https://x.y)` as md instead of plain text.
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  if (looksLikeStructuralMarkdown(text)) return true;
  return [
    /!\[[^\]]*\]\([^)]+\)/,   // ![alt](url)
    /\[[^\]]+\]\([^)]+\)/,    // [text](url)
  ].some((re) => re.test(text));
}

export function MilkdownEditor({
  initialMarkdown,
  readOnly,
  onChange,
  onReady,
  onPasteImage,
  onPasteFile,
  onMentionQuery,
}: MilkdownEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  // 编辑器初始化失败(如 Milkdown 升级后 API 变化)时给用户明确提示，否则只会看到空白编辑区。
  const [loadError, setLoadError] = useState<string | null>(null);

  // Refs let DOM-level handlers read the latest callbacks without re-creating Crepe.
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const onPasteImageRef = useRef(onPasteImage);
  const onPasteFileRef = useRef(onPasteFile);
  const onMentionQueryRef = useRef(onMentionQuery);
  onChangeRef.current = onChange;
  onReadyRef.current = onReady;
  onPasteImageRef.current = onPasteImage;
  onPasteFileRef.current = onPasteFile;
  onMentionQueryRef.current = onMentionQuery;

  // Code-block「Copy」→「已复制」反馈。Crepe 的 CodeMirror 代码块右侧有个 Copy
  // 按钮(.tools-button-group 里、文本为 "Copy"),它会复制但没有「已复制」状态。
  // 委托一个 click 监听:点中 Copy 按钮时给它加 data-tm-copied(1.5s),由
  // milkdown.css 把标签切成「已复制」。仅认带 copy/复制 文案的那个按钮(同组里
  // 可能还有预览/编辑切换按钮)。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        ".milkdown-code-block .tools-button-group button",
      );
      if (!btn || !/copy|复制/i.test(btn.textContent ?? "")) return;
      btn.setAttribute("data-tm-copied", "1");
      window.setTimeout(() => btn.removeAttribute("data-tm-copied"), 1500);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const crepe = new Crepe({
      root,
      // 存储形态(/uploads/*)→ 显示形态(带 BASE_URL 前缀):应用部署在子路径下时,
      // 根绝对的 /uploads 会 404。序列化输出时由
      // 下面 markdownUpdated 的 uploadsToStorage 逆变换,存储格式不变。
      defaultValue: uploadsToDisplay(initialMarkdown),
      // TopBar is opt-in in Crepe (defaults to off). It renders a fixed
      // top toolbar with heading selector + bold/italic/etc formatting
      // buttons that's always visible while editing — distinct from the
      // selection-only Toolbar bubble.
      //
      // Toolbar (the floating bubble shown on text selection) is turned OFF
      // per UX request — the TopBar already exposes the same formatting, and
      // the bubble popping up on every double-click was distracting. The
      // `featureConfigs[Toolbar]` block below is now inert but kept so the
      // bubble (with its H1-H6 / quote items) can be re-enabled by flipping
      // this back to `true`. BlockEdit / ImageBlock stay on (Crepe defaults).
      features: {
        [Crepe.Feature.TopBar]: true,
        [Crepe.Feature.Toolbar]: false,
      },
      featureConfigs: {
        // Add a visible「上传文件」button to the always-on TopBar so users
        // don't have to discover the slash-menu "Insert File" item. Same
        // behavior: pick any file → upload via onPasteFile → insert an
        // attachment link `[📎 name (size)](url)` at the cursor. buildTopBar
        // is ADDITIVE — Crepe's default heading/mark/list buttons stay; our
        // group appends after a divider. TopBar auto-hides in read-only mode,
        // so the button only shows while editing (matches upload semantics).
        [Crepe.Feature.TopBar]: {
          buildTopBar: (builder) => {
            const group = builder.addGroup("tm-upload", "Upload");
            group.addItem("upload-file", {
              icon: ICON_ATTACHMENT,
              // Not a toggle — never renders in an "active" state.
              active: () => false,
              onRun: async (ctx) => {
                const handler = onPasteFileRef.current;
                if (!handler) {
                  toast.error(tr("article.editor.fileUploadNotConfigured"));
                  return;
                }
                const file = await openFilePicker();
                if (!file) return;
                try {
                  const { url, displayName } = await handler(file);
                  insertAttachmentLink(ctx.get(editorViewCtx), displayName, url, file.size);
                } catch (err) {
                  toast.error(tr("article.editor.fileUploadFailed", { msg: (err as Error).message }));
                }
              },
            });
          },
        },
        // Render ```mermaid code blocks as diagrams (lazy mermaid). Non-mermaid
        // languages return null → normal code view. Read-only shows the diagram
        // by default; in edit mode the source stays editable (toggle preview).
        [Crepe.Feature.CodeMirror]: {
          previewOnlyByDefault: readOnly,
          renderPreview: (
            language: string,
            content: string,
            applyPreview: (value: string | HTMLElement | null) => void,
          ) => {
            if ((language ?? "").toLowerCase() !== "mermaid" || !content.trim()) return null;
            const seq = ++mermaidSeq;
            renderMermaidToSvg(content, seq)
              .then((svg) => applyPreview(svg))
              .catch(() => applyPreview(tr("article.editor.mermaidFailed")));
            return undefined; // async: library shows previewLoading, then our SVG
          },
        },
        // (Fix A) Wire Crepe's image-block upload paths (drag-drop, slash
        // menu, toolbar "Insert Image") through our /api/uploads/image
        // endpoint. Without this, those affordances are silent no-ops.
        // Reads the latest callback via ref so the editor doesn't have to
        // remount when the parent component swaps the prop.
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file: File) => {
            const fn = onPasteImageRef.current;
            if (!fn) throw new Error("upload handler not configured");
            // 编辑器内用显示形态地址(见 insertAttachmentLink 处说明)。
            return uploadSrc(await fn(file));
          },
        },
        // Extend the slash menu (Crepe's "+" button / typing `/`) with:
        //   - "Insert Image" — REPLACES Crepe's default image item.
        //     Stock behavior inserts an empty image-block that then
        //     needs another click on "Upload file"; ours opens the
        //     OS picker immediately, uploads, and drops a fully-
        //     formed image-block (src already set) at the cursor.
        //   - "Insert Table" / "Insert Math" — REPLACE the stock
        //     items. Stock used `addBlockTypeCommand`, which inserts
        //     AFTER the current block; on an empty paragraph that
        //     leaves a stray blank line above the new block. Our
        //     versions go through `insertBlockInPlace` so an empty
        //     parent gets replaced instead.
        //   - "Insert File" — generic attachment as a markdown link
        //     (commonmark has no attachment node).
        // Code block is intentionally NOT overridden: Crepe's default
        // uses `setBlockTypeCommand`, which already converts the
        // current paragraph in place — no fix needed.
        [Crepe.Feature.BlockEdit]: {
          advancedGroup: { image: null, table: null, math: null },
          buildMenu: (builder) => {
            const advanced = builder.getGroup("advanced");
            advanced.addItem("image", {
              label: "Insert Image",
              icon: ICON_IMAGE,
              onRun: async (ctx) => {
                const uploader = onPasteImageRef.current;
                if (!uploader) {
                  toast.error(tr("article.editor.imageUploadNotConfigured"));
                  return;
                }
                const file = await openFilePicker("image/*");
                if (!file) return;
                // Clear the "/" trigger + any partial filter so it
                // doesn't survive above the inserted block.
                ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
                try {
                  const url = uploadSrc(await uploader(file));
                  const schema = ctx.get(schemaCtx);
                  const imageBlock = schema.nodes["image-block"];
                  if (!imageBlock) {
                    // Defensive — ImageBlock feature is configured
                    // above so this branch should be unreachable.
                    toast.error(tr("article.editor.imageBlockMissing"));
                    return;
                  }
                  insertBlockInPlace(ctx, imageBlock.create({ src: url, caption: "", ratio: 1 }));
                } catch (err) {
                  toast.error(tr("article.editor.imageUploadFailed", { msg: (err as Error).message }));
                }
              },
            });
            advanced.addItem("table", {
              label: "Insert Table",
              icon: ICON_TABLE,
              onRun: (ctx) => {
                ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
                // Crepe ships a `createTable(ctx, rows, cols)` helper
                // that returns a properly-shaped table node (header
                // row + body rows + cells). 3×3 matches the default.
                insertBlockInPlace(ctx, createTable(ctx, 3, 3));
              },
            });
            advanced.addItem("math", {
              label: "Insert Math",
              icon: ICON_MATH,
              onRun: (ctx) => {
                ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
                const schema = ctx.get(schemaCtx);
                const codeBlock = schema.nodes.code_block;
                if (!codeBlock) {
                  toast.error(tr("article.editor.codeBlockMissing"));
                  return;
                }
                // Math = code_block with `language: "LaTeX"`. Crepe's
                // Latex feature picks up that attr to render
                // KaTeX-rendered output below the source.
                insertBlockInPlace(ctx, codeBlock.create({ language: "LaTeX" }));
              },
            });
            advanced.addItem("file", {
              label: "Insert File",
              icon: ICON_ATTACHMENT,
              onRun: async (ctx) => {
                const handler = onPasteFileRef.current;
                if (!handler) {
                  toast.error(tr("article.editor.fileUploadNotConfigured"));
                  return;
                }
                const file = await openFilePicker();
                if (!file) return;
                // Same "stay on current line" semantic as Insert
                // Image — clear any slash trigger first, then insert
                // the markdown text. Since this is text (not a
                // block node), `insertText` lands at the cursor
                // automatically; we just need to clear the line so
                // the file link doesn't sit alongside the slash text.
                ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
                try {
                  const { url, displayName } = await handler(file);
                  insertAttachmentLink(ctx.get(editorViewCtx), displayName, url, file.size);
                } catch (err) {
                  toast.error(tr("article.editor.fileUploadFailed", { msg: (err as Error).message }));
                }
              },
            });
          },
        },
        // Extend the selection bubble menu with block-type buttons that
        // most users expect (H1/H2/H3 and Quote). Crepe's default Toolbar
        // ships only inline marks because headings/quotes are block-level
        // and don't strictly belong in a "selection formatter". For UX
        // parity with Notion/Feishu we add them anyway — clicking applies
        // to the block containing the cursor, regardless of selection.
        [Crepe.Feature.Toolbar]: {
          buildToolbar: (builder) => {
            const blockGroup = builder.addGroup("block", "Block");
            const headingItem = (level: 1 | 2 | 3 | 4 | 5 | 6, icon: string) => ({
              icon,
              active: (ctx: Ctx) => {
                const view = ctx.get(editorViewCtx);
                const { $from } = view.state.selection;
                for (let d = $from.depth; d >= 0; d--) {
                  const n = $from.node(d);
                  if (n.type.name === "heading") return n.attrs.level === level;
                }
                return false;
              },
              // Toolbar buttons fire on pointerdown, which on some
              // browsers steals focus from the editor view. The next
              // dblclick then re-focuses ProseMirror, and the focus
              // round-trip is what re-mounts the virtual cursor in a
              // way that briefly shifts the heading's baseline. Call
              // view.focus() right after the block-type change so focus
              // never leaves the editor in the first place.
              onRun: (ctx: Ctx) => {
                ctx.get(commandsCtx).call(wrapInHeadingCommand.key, level);
                ctx.get(editorViewCtx).focus();
              },
            });
            blockGroup
              .addItem("h1", headingItem(1, ICON_H1))
              .addItem("h2", headingItem(2, ICON_H2))
              .addItem("h3", headingItem(3, ICON_H3))
              .addItem("h4", headingItem(4, ICON_H4))
              .addItem("h5", headingItem(5, ICON_H5))
              .addItem("h6", headingItem(6, ICON_H6))
              .addItem("quote", {
                icon: ICON_QUOTE,
                active: (ctx: Ctx) => {
                  const view = ctx.get(editorViewCtx);
                  const { $from } = view.state.selection;
                  for (let d = $from.depth; d >= 0; d--) {
                    if ($from.node(d).type.name === "blockquote") return true;
                  }
                  return false;
                },
                onRun: (ctx: Ctx) => {
                  ctx.get(commandsCtx).call(wrapInBlockquoteCommand.key);
                  ctx.get(editorViewCtx).focus();
                },
              });
          },
        },
      },
    });

    // Crepe's BlockHandle "+" button is hardcoded to ALWAYS insert a
    // fresh empty paragraph after the active block before opening the
    // slash menu (see @milkdown/crepe handle/index.ts onAdd). When the
    // active block is already an empty paragraph, this leaves the user
    // staring at TWO empty lines — the original one + the new one — and
    // the cursor / menu attached to the NEW one. Visually it feels like
    // the editor "added a line for no reason".
    //
    // We can't override Crepe's onAdd without re-implementing the whole
    // BlockHandle view (BlockProvider plumbing, menuAPI internals, etc.),
    // so we detect the situation post-hoc:
    //   1. A document-level pointerdown listener (capture phase, runs
    //      BEFORE Crepe's bubble-phase handler) flags any tap on the
    //      "+" button inside `.milkdown-block-handle`.
    //   2. The `dispatchTransaction` wrapper below sees the next
    //      transaction land us in an empty paragraph that's preceded by
    //      another empty paragraph — exactly the BlockHandle's residue
    //      pattern — and immediately appends a delete-the-prev cleanup
    //      transaction. End result: ONE empty line + menu anchored on it.
    // The flag auto-clears after 250ms so any subsequent manual Enter
    // (which is structurally similar but unrelated) is unaffected.
    const addBtnState = { recentlyClicked: false, timer: 0 };
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const handle = target.closest(".milkdown-block-handle");
      if (!handle) return;
      const items = handle.querySelectorAll(".operation-item");
      if (items[0]?.contains(target)) {
        addBtnState.recentlyClicked = true;
        if (addBtnState.timer) window.clearTimeout(addBtnState.timer);
        addBtnState.timer = window.setTimeout(() => {
          addBtnState.recentlyClicked = false;
        }, 250);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);

    // (Issue 4 diagnostics) Opt-in: run `localStorage.setItem("debug:editor-jump","1")`
    // in DevTools, then double-click a line. Logs the editor + first-block
    // VIEWPORT positions and the scroll offsets BEFORE the click and two frames
    // AFTER — so we can see exactly WHAT shifts (a layout reflow vs a scroll) and
    // by how many px when selecting. Cheap no-op unless the flag is set.
    const findScroller = (el: HTMLElement | null): HTMLElement | null => {
      let n: HTMLElement | null = el?.parentElement ?? null;
      while (n) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
        n = n.parentElement;
      }
      return null;
    };
    const snapshotGeometry = () => {
      const pm = root.querySelector<HTMLElement>(".ProseMirror");
      const first = pm?.firstElementChild as HTMLElement | null;
      const scroller = findScroller(pm);
      return {
        pmTop: pm ? Math.round(pm.getBoundingClientRect().top) : null,
        firstBlockTop: first ? Math.round(first.getBoundingClientRect().top) : null,
        scrollerTop: scroller ? Math.round(scroller.scrollTop) : null,
        pageScrollTop: Math.round(document.scrollingElement?.scrollTop ?? window.scrollY),
        hasVirtualCursor: !!root.querySelector(".prosemirror-virtual-cursor"),
      };
    };
    const onDblDebug = () => {
      if (typeof window === "undefined" || window.localStorage?.getItem("debug:editor-jump") !== "1") return;
      const before = snapshotGeometry();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const after = snapshotGeometry();
        // eslint-disable-next-line no-console
        console.debug("[MilkdownEditor] editor-jump on dblclick", {
          before, after,
          deltaPmTop: (after.pmTop ?? 0) - (before.pmTop ?? 0),
          deltaFirstBlockTop: (after.firstBlockTop ?? 0) - (before.firstBlockTop ?? 0),
          deltaScrollerTop: (after.scrollerTop ?? 0) - (before.scrollerTop ?? 0),
          deltaPageScroll: (after.pageScrollTop ?? 0) - (before.pageScrollTop ?? 0),
        });
      }));
    };
    root.addEventListener("dblclick", onDblDebug);

    // 注册「附件原子卡片」节点 + 其 remark 解析转换(见 fileAttachment.ts)。
    // 必须在 create() 前挂上,schema/序列化/解析才生效。
    crepe.editor.use(fileAttachmentPlugins);

    crepe.editor.config((ctx) => {
      // Behavioural plugin for Crepe's block gutter handle: toggle a
      // `tm-block-empty` class on the handle DOM whenever the hovered
      // block is an empty textblock. The companion CSS (milkdown.css)
      // uses that class to show the "+" only on empty rows and hide
      // the 6-dot drag affordance everywhere — see the explanation
      // there for why we dropped the 6-dots interaction.
      ctx.update(prosePluginsCtx, (prev) => [
        ...prev,
        new PMPlugin({
          view(editorView) {
            const onMouseMove = (e: MouseEvent) => {
              const pos = editorView.posAtCoords({ left: e.clientX, top: e.clientY });
              if (!pos) return;
              const $pos = editorView.state.doc.resolve(pos.pos);
              if ($pos.depth < 1) return;
              // Immediate textblock parent (`$pos.depth`), not a
              // hardcoded depth=1 — handles paragraphs nested inside
              // list items, blockquotes, etc.
              const block = $pos.node($pos.depth);
              const isEmpty = block.isTextblock && block.content.size === 0;
              const handle = document.querySelector(".milkdown-block-handle");
              if (handle) handle.classList.toggle("tm-block-empty", isEmpty);
            };
            editorView.dom.addEventListener("mousemove", onMouseMove);
            return {
              destroy() {
                editorView.dom.removeEventListener("mousemove", onMouseMove);
              },
            };
          },
        }),
      ]);

      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        // Merge BlockHandle's residual empty paragraph — see the long
        // comment above `addBtnState`. We modify Crepe's transaction
        // IN PLACE (adding a delete step) before applying it, so the
        // whole thing lands as a single atomic update. A previous
        // version dispatched the cleanup as a SECOND transaction, but
        // Crepe's onAdd reads `tr.selection.from` and calls
        // `menuAPI.show(...)` immediately after our dispatch returns —
        // the second transaction then shifted the doc, invalidating
        // the menu's anchor, and the menu would briefly appear and
        // disappear ("a flash, no menu").
        dispatchTransaction(tr) {
          // `this` is the EditorView at runtime. Type as `unknown` then
          // narrow — ProseMirror's PluginView typing doesn't carry the
          // view here.
          const view = this as unknown as import("prosemirror-view").EditorView;
          if (addBtnState.recentlyClicked && tr.docChanged) {
            // Only act on the FIRST dispatch after the + click.
            addBtnState.recentlyClicked = false;
            const $from = tr.selection.$from;
            // Crepe's onAdd ALWAYS inserts an empty paragraph after
            // the active block — that's the only shape we want to
            // unwind. If the user's previous (active) block was also
            // empty, the menu should stick to THAT block instead of
            // creating a stray new paragraph below it.
            //
            // Strategy: delete the JUST-INSERTED empty paragraph (NOT
            // the previous block) and move the cursor into the prev
            // block. This preserves the user's original block type
            // (paragraph, H1, blockquote, code, …) while still landing
            // the menu on the line they were on. ProseMirror's
            // selection mapping after a delete usually drops us at
            // the boundary, so we explicitly place a TextSelection
            // inside the prev block to anchor the slash menu there.
            if ($from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
              const newBlockStart = $from.before($from.depth);
              const newBlockEnd = $from.after($from.depth);
              if (newBlockStart > 0) {
                const before = tr.doc.resolve(newBlockStart);
                const prev = before.nodeBefore;
                if (prev && prev.isTextblock && prev.content.size === 0) {
                  tr.delete(newBlockStart, newBlockEnd);
                  // After deletion the prev block's content-end sits
                  // at newBlockStart - 1 in the post-delete doc. Park
                  // a collapsed cursor there so Crepe's
                  // `menuAPI.show(tr.selection.from)` (called right
                  // after this dispatch returns) anchors the slash
                  // menu on the prev block.
                  tr.setSelection(TextSelection.create(tr.doc, newBlockStart - 1));
                }
              }
            }
          }
          view.updateState(view.state.apply(tr));
        },
        // Don't let ProseMirror jump the document on every selection change.
        // Returning true means "handled, don't do default" — the browser's
        // native contenteditable behavior keeps the cursor visible in the
        // common cases (typing, arrow-key nav) without yanking the scroll
        // position on a mid-page double-click.
        handleScrollToSelection: () => true,
        // 点击附件卡片(.tm-file-chip 原子节点)的处理:
        //  - 点卡片上的「×」删除按钮(仅编辑态可见)→ 整块删除该原子节点;
        //  - 点卡片其余部分 → 用地址(data-src)在【新页】打开预览/下载,当前页不动。
        // 卡片刻意不带 href(见 fileAttachment.ts),避免原生 <a> 把当前页也导航掉;
        // 地址一律从 data-src 取,由 window.open 开新页。服务端对 pdf/图片/文本类
        // inline 预览,其它类型带 Content-Disposition: attachment 下载,均同源 cookie
        // 鉴权。两种态都 preventDefault + 返回 true,阻止 PM 把光标落进去。非附件的
        // 普通链接/提及不拦截,交回默认行为(链接工具条等)。
        handleClick: (view, _pos, event) => {
          const target = event.target as HTMLElement | null;
          // (1) 「×」删除:定位到被点的原子节点并整块删除。只在可编辑态生效
          //     (只读态 × 由 CSS 隐藏,这里再兜底一次,避免程序化改动只读文档)。
          const removeBtn = target?.closest?.(".tm-file-chip-remove") as HTMLElement | null;
          if (removeBtn && view.editable) {
            event.preventDefault();
            try {
              // posAtDOM 落在原子内部任意 DOM 上,返回的是该原子节点之前的位置。
              const pos = view.posAtDOM(removeBtn, 0);
              const node = view.state.doc.nodeAt(pos);
              if (node && node.type.name === FILE_ATTACHMENT_ID) {
                view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
              }
            } catch { /* 定位失败则放弃删除,不影响其它交互 */ }
            return true;
          }
          // (2) 点卡片其余部分 → 新页打开预览/下载。
          const chip = target?.closest?.(".tm-file-chip") as HTMLElement | null;
          const src = chip?.getAttribute("data-src");
          if (!src) return false;
          event.preventDefault();
          const url = openableUploadUrl(src, window.location.origin);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
          return true;
        },
        // Convert pasted `<br>`-split paragraphs into sibling paragraphs.
        // See the doc comment on `splitParagraphsAtHardBreaks` for the
        // bug this avoids (toggling a mark across hardBreaks produced
        // weird structural reshuffles after re-serialization).
        transformPasted: (slice, view) => splitParagraphsAtHardBreaks(slice, view.state.schema),
        // Drag-and-drop of arbitrary files from the OS file picker.
        // Images keep going through Crepe's ImageBlock onUpload (so
        // they land as `![](...)` block images); anything else is
        // handled here and inserted as a generic attachment link.
        // Returning true tells ProseMirror we consumed the drop.
        handleDrop: (view, event, _slice, _moved) => {
          const fileHandler = onPasteFileRef.current;
          if (!fileHandler) return false;
          const dt = event.dataTransfer;
          if (!dt || !dt.files || dt.files.length === 0) return false;
          const nonImage = Array.from(dt.files).filter((f) => !f.type.startsWith("image/"));
          if (nonImage.length === 0) return false;
          event.preventDefault();
          // Move the cursor to where the user dropped before insertion,
          // so dropping mid-paragraph lands the link at the drop point.
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (pos) {
            view.dispatch(
              view.state.tr.setSelection(PMSelection.near(view.state.doc.resolve(pos.pos))),
            );
          }
          // Fire-and-forget — but with a top-level catch so an
          // unexpected throw (e.g. `view.state.tr` against a destroyed
          // view, despite the isConnected guard below) doesn't become
          // an UnhandledPromiseRejection in production.
          (async () => {
            for (let i = 0; i < nonImage.length; i++) {
              const file = nonImage[i];
              try {
                const { url, displayName } = await fileHandler(file);
                // The await can yield to the event loop —
                // by the time we resume, the editor view may have been
                // destroyed (page nav, StrictMode unmount). Reading
                // `view.state` on a torn-down view throws. Bail out if
                // the view's DOM is no longer attached. Also re-read
                // `view.state.tr` fresh so concurrent edits between
                // uploads can't make us dispatch a stale transaction
                // against a moved-on document.
                if (!view.dom.isConnected) return;
                // 多个文件之间用一个空格分隔(链接是行内节点,不换行)。
                if (i > 0) view.dispatch(view.state.tr.insertText(" "));
                insertAttachmentLink(view, displayName, url, file.size);
              } catch (err) {
                toast.error(tr("article.editor.fileUploadFailed", { msg: (err as Error).message }));
              }
            }
          })().catch((err) => {
            console.error("[MilkdownEditor] drop upload IIFE crashed:", err);
          });
          return true;
        },
        handlePaste: (view, event) => {
          const handler = onPasteImageRef.current;
          const cd = event.clipboardData;
          if (!cd) return false;

          // (1) Image file in clipboard (e.g. Cmd+V after screenshot)
          if (handler) {
            const items = cd.items;
            if (items) {
              for (const item of items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (!file) continue;
                  event.preventDefault();
                  handler(file)
                    .then((url) => {
                      // 显示形态(uploadSrc 补 BASE_URL 前缀)—— 否则刚粘贴的
                      // 截图在编辑器里就是裂的(0285e15 修图裂时漏了本路径)。
                      view.dispatch(view.state.tr.insertText(`![](${uploadSrc(url)})`));
                    })
                    .catch((err: unknown) => {
                      toast.error(tr("article.editor.imageUploadFailed", { msg: (err as Error).message }));
                    });
                  return true;
                }
              }
            }
          }

          // (1b) Non-image file in clipboard (e.g. drag-paste a .pdf or
          // .docx). Insert as a markdown link the user can click to
          // preview/download. Only triggers when the parent wired up
          // onPasteFile.
          const fileHandler = onPasteFileRef.current;
          if (fileHandler && cd.files && cd.files.length > 0) {
            const file = cd.files[0];
            if (!file.type.startsWith("image/")) {
              event.preventDefault();
              fileHandler(file)
                .then(({ url, displayName }) => {
                  insertAttachmentLink(view, displayName, url, file.size);
                })
                .catch((err: unknown) => {
                  toast.error(tr("article.editor.fileUploadFailed", { msg: (err as Error).message }));
                });
              return true;
            }
          }

          // (2, Fix B) HTML with inline base64 images (Word, Google Docs,
          // some webpages). Upload them and re-insert with /uploads/* URLs
          // so they go through the Upload permission gate and don't bloat
          // the article's markdown with base64 strings.
          const html = cd.getData("text/html");
          if (html && handler && /<img[^>]+src\s*=\s*"data:image\//i.test(html)) {
            event.preventDefault();
            (async () => {
              const div = parseClipboardHtml(html);
              await transcodeBase64Images(div, handler);
              // The multi-image upload above yields to the event loop;
              // the editor may have been torn down (page nav / unmount) by the
              // time we resume. Reading view.state on a destroyed view throws —
              // mirror the drop handler's isConnected guard and bail out.
              if (!view.dom.isConnected) return;
              insertHtmlAtCursor(view, div.innerHTML);
            })().catch((err) => {
              toast.error(tr("article.editor.pasteFailed", { msg: (err as Error).message }));
            });
            return true;
          }

          // (2a, Fix D) Markdown paste. Three trap cases this owns:
          //   - VS Code copy with `mode="markdown"` on the
          //     `vscode-editor-data` clipboard format. The stock
          //     @milkdown/plugin-clipboard would wrap the entire
          //     payload into a code_block with language="markdown" —
          //     correct for source code, wrong for an actual .md
          //     file where the user expects headings/lists/links
          //     to render.
          //   - Any paste whose `text/plain` carries block-level
          //     markdown syntax (`##` / fences / `-` / `>` / `|`).
          //     We trust this over whatever `text/html` looks like
          //     because every common source of structural md (.md
          //     file, GitHub raw, chat-tool code blocks, our own
          //     editor's "copy as md") carries the same source in
          //     text/plain — and parsing it deterministically here
          //     beats guessing at arbitrary HTML wrapping (e.g.
          //     `<div><pre><code class="lang-md">…</code></pre></div>`)
          //     that PMDOMParser would otherwise collapse into a
          //     single code_block.
          //   - Plain-text paste with no HTML at all, where the
          //     text looks even loosely like md (incl. inline
          //     `[link](url)`). Without this branch, (2b) below or
          //     the default plugin can mangle these.
          {
            const text = cd.getData("text/plain");
            const vscodeData = cd.getData("vscode-editor-data");
            let vscodeMode: string | undefined;
            if (vscodeData) {
              try {
                vscodeMode = (JSON.parse(vscodeData) as { mode?: string }).mode;
              } catch {
                /* not JSON — ignore */
              }
            }
            const treatAsMarkdown =
              vscodeMode === "markdown" ||
              looksLikeStructuralMarkdown(text) ||
              (!html && looksLikeMarkdown(text));

            // Opt-in diagnostics. Run `localStorage.setItem("debug:paste","1")`
            // in DevTools and paste again to dump what the clipboard
            // actually carried + which routing branch fired. Helps
            // confirm whether a misbehaving source is hitting (2a),
            // (2b), or the default Milkdown clipboard plugin.
            if (
              typeof window !== "undefined" &&
              window.localStorage?.getItem("debug:paste") === "1"
            ) {
              // eslint-disable-next-line no-console
              console.debug("[MilkdownEditor] paste", {
                textLen: text.length,
                textHead: text.slice(0, 240),
                htmlLen: html?.length ?? 0,
                htmlHead: html?.slice(0, 400) ?? "",
                vscodeMode,
                looksLikeStructural: looksLikeStructuralMarkdown(text),
                looksLikeAny: looksLikeMarkdown(text),
                treatAsMarkdown,
              });
            }

            if (treatAsMarkdown) {
              // Mirror @milkdown/plugin-clipboard: if the user is
              // pasting *into* a code block they want raw text, not
              // an md re-parse. Fall through so the default flow
              // inserts the characters verbatim.
              if (view.state.selection.$from.node().type.spec.code) {
                return false;
              }
              event.preventDefault();
              crepeRef.current?.editor.action((ctx) => {
                const parser = ctx.get(parserCtx);
                // 粘贴的 markdown 可能带存储形态的 /uploads/* 链接(从别的
                // 文章源码复制)——按显示形态进编辑器,图才不裂。
                const node = parser(uploadsToDisplay(text));
                // parser() returns Node | string (error cases); guard both.
                if (!node || typeof node === "string") return;
                // node is a top-level doc; its `content` Fragment is
                // already block-level. Wrap as a fully-closed slice
                // (openStart=openEnd=0) and replace selection — no
                // need for the DOM serialize / re-parse round-trip
                // we used to do.
                view.dispatch(
                  view.state.tr.replaceSelection(new PMSlice(node.content, 0, 0)),
                );
              });
              return true;
            }
          }

          // (2b) Code-block normalization. Many sources copy code as
          // `<pre>text</pre>` or `<pre><div>...` without an inner
          // `<code>` element — ProseMirror's parser then produces an
          // empty code_block (or no code_block at all) and the actual
          // source falls out into a sibling paragraph. The visible
          // symptom is "empty code block, code as plain text below".
          // Walk every <pre> in the clipboard HTML; if it has no
          // <code> child, wrap its text content in one so PMDOMParser
          // can map it correctly. Also drops `<pre>`-internal `<br>`
          // tags into real newlines because ProseMirror's text
          // serializer ignores them inside code_block.
          if (html && /<pre[\s>]/i.test(html)) {
            const div = parseClipboardHtml(html);
            let normalized = false;
            div.querySelectorAll("pre").forEach((pre) => {
              if (pre.querySelector("code")) return;
              const text = Array.from(pre.childNodes)
                .map((n) => (n.nodeName === "BR" ? "\n" : (n.textContent ?? "")))
                .join("");
              const code = document.createElement("code");
              code.textContent = text;
              pre.textContent = "";
              pre.appendChild(code);
              normalized = true;
            });
            if (normalized) {
              event.preventDefault();
              insertHtmlAtCursor(view, div.innerHTML);
              return true;
            }
          }

          // (3, Fix C) Very large paste — synchronous ProseMirror processing
          // can freeze the UI. Ask before continuing.
          const text = cd.getData("text/plain") ?? "";
          const size = Math.max(text.length, html?.length ?? 0);
          if (size > LARGE_PASTE_THRESHOLD) {
            const kb = (size / 1024).toFixed(0);
            // Kept as window.confirm intentionally: this runs inside
            // a synchronous ProseMirror handlePaste callback that
            // MUST return its decision in the same tick. An async
            // dialog.confirm would resolve after PM has already
            // processed the paste, defeating the guard. The native
            // dialog is acceptable here because (a) the path is
            // rare (only > LARGE_PASTE_THRESHOLD bytes), (b) the
            // guard is correctness-critical (we trade UI polish
            // for not freezing the editor on a 500KB paste).
            // eslint-disable-next-line no-alert
            if (!window.confirm(tr("article.editor.bigPaste", { kb }))) {
              event.preventDefault();
              return true;
            }
          }

          return false;
        },
        handleDOMEvents: {
          ...(prev?.handleDOMEvents ?? {}),
          input: (view) => {
            if (!onMentionQueryRef.current) return false;
            const { from } = view.state.selection;
            const text = view.state.doc.textBetween(Math.max(0, from - 64), from, "\n", "\n");
            const m = text.match(/(?:^|\s)@([^\s@]*)$/);
            if (m) {
              const start = from - (m[1]?.length ?? 0);
              const coords = view.coordsAtPos(from);
              setMention({ query: m[1] ?? "", anchor: { left: coords.left, top: coords.bottom }, start });
            } else {
              setMention(null);
            }
            return false;
          },
        },
      }));
    });

    // Crepe 在【创建阶段】会对 initialMarkdown 做一次 parse→serialize 归一化
    // (尾换行/列表符号等的微小出入),并可能借 markdownUpdated 把这个「非用户」
    // 变更也上报出来。就绪(onReady)前一律不当作 onChange 抛给上层 —— 否则
    // 查看态下 body 会先被归一化值改脏、而 baseline 仍是原始值,dirty 永不和解,
    // 触发「有未保存的修改,确定离开?」拦截弹窗(见 ArticlePage useUnsavedGuard)。
    // 就绪后再放行,真实输入/工具栏/粘贴照常标脏并自动保存。
    let ready = false;
    // 记录最近一次归一化结果:就绪时用它作为回传给上层的「基线」——与后续 onChange
    // 走同一条序列化路径(markdownUpdated),避免 getMarkdown() 与 markdownUpdated
    // 两条路径的细微出入再次把「加载即变脏」引回来。
    let lastMd: string | null = null;
    crepe.on((api) => {
      api.markdownUpdated((_ctx, newMd) => {
        // 显示形态 → 存储形态(剥 BASE_URL 前缀),保证落库/导出的
        // markdown 与历史内容一致,不携带部署前缀。
        const md = uploadsToStorage(newMd);
        lastMd = md;
        if (!ready) return; // 就绪前的归一化不是用户编辑,吞掉
        onChangeRef.current?.(md);
      });
    });

    crepeRef.current = crepe;
    let cancelled = false;
    // 顶栏中文 tooltip 的观察器:顶栏是 Vue 应用,只读切换会重造按钮,
    // 需在其重建时重新贴 title(见 applyTopBarTitles)。
    let titleObserver: MutationObserver | null = null;
    crepe.create()
      .then(() => {
        if (cancelled) {
          // React 18 StrictMode fires mount → cleanup → mount synchronously
          // in dev. If create() is still pending when cleanup runs, our
          // destroy() can't reach the not-yet-built editor — then when
          // create resolves it would append a second editor view to the
          // same root DOM, leaving two overlapping editor instances on
          // the same node (which collapses padding-on-selection visually).
          // Destroy the orphan immediately when cancelled is set.
          crepe.destroy().catch(() => { /* ignore */ });
          return;
        }
        // 创建完成:放行 onChange,并回传编辑器归一化后的实际内容,让调用方把基线
        // 对齐到它,从而「加载即变脏」不再发生(归一化差异不会被当成用户编辑)。
        // 优先用 markdownUpdated 捕获到的归一化值,退化到 getMarkdown()。
        ready = true;
        try {
          onReadyRef.current?.(lastMd ?? uploadsToStorage(crepe.getMarkdown()));
        } catch { /* getMarkdown 理论上不会抛;失败则放弃对齐(退化为旧行为) */ }
        // 顶栏此时已挂到编辑器根内(view.dom.parentElement 的首个子节点)。
        // 补一次中文 tooltip,并观察顶栏重建(只读切换会重造按钮)时重贴。
        // childList/subtree 变更才触发,active 态只改 class(属性)不触发,
        // 故打字/选区变化不会造成多余回调。
        const topbar = root.querySelector<HTMLElement>(".milkdown-top-bar");
        if (topbar) {
          applyTopBarTitles(topbar);
          titleObserver = new MutationObserver(() => applyTopBarTitles(topbar));
          titleObserver.observe(topbar, { childList: true, subtree: true });
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[MilkdownEditor] Crepe.create() failed:", err);
        if (!cancelled) setLoadError((err as Error)?.message || tr("article.editor.unknownError"));
      });

    return () => {
      cancelled = true;
      titleObserver?.disconnect();
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      root.removeEventListener("dblclick", onDblDebug);
      if (addBtnState.timer) window.clearTimeout(addBtnState.timer);
      crepe.destroy().catch(() => { /* ignore */ });
      crepeRef.current = null;
    };
    // Intentionally mount-once: editor lifecycle is independent of prop changes.
    // initialMarkdown only matters at first mount; readOnly is hot-toggled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    crepeRef.current?.setReadonly(!!readOnly);
  }, [readOnly]);

  const insertMention = useCallback((hit: ArticleSearchHit) => {
    const crepe = crepeRef.current;
    if (!crepe || !mention) return;
    const { start } = mention;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from } = view.state.selection;
      const link = `[${hit.title}](/d/${hit.id})`;
      view.dispatch(view.state.tr.delete(start - 1, from).insertText(link));
    });
    setMention(null);
  }, [mention]);

  return (
    <div className="tm-editor" data-readonly={readOnly ? "true" : "false"}>
      <div ref={rootRef} />
      {loadError && (
        <div role="alert" className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {tr("article.editor.loadFailed", { error: loadError })}
          <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>{tr("article.editor.reload")}</button>
        </div>
      )}
      {mention && onMentionQuery && (
        <MentionPopover
          query={mention.query}
          anchor={mention.anchor}
          search={onMentionQuery}
          onSelect={insertMention}
          onClose={() => setMention(null)}
        />
      )}
    </div>
  );
}
