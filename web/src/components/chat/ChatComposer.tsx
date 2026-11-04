import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { api, uploadSrc } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { ChatMentionPopover, type ChatMentionItem } from "./ChatMentionPopover";
import { getAssistantName } from "@/lib/assistantName";
import { useT } from "@/i18n";

interface Props {
  onSend(
    content: string,
    mentions: { type: "doc" | "folder" | "role" | "skill"; id: string; label: string }[],
    /** 随消息上传的图片(/uploads/<file>,已上传完成)。 */
    images: string[],
  ): void;
  disabled: boolean;
  /** When provided, the send button morphs into a stop button while
   *  `disabled` (i.e. while the chat is sending/streaming). Click
   *  aborts the in-flight stream — callers wire this to the same
   *  AbortController used by streamChat. Omit to keep the old
   *  behavior of just disabling the send button. */
  onStop?(): void;
  /** 渲染在输入框上方的可选插槽(首页统一聊天用来放专家选择条;气泡不传)。 */
  headerSlot?: ReactNode;
  /** 提供时在发送键左侧渲染「多选分享」按钮;点击进入/退出多选(由上层切换)。 */
  onShare?: () => void;
  /** 多选进行中 → 高亮分享按钮。 */
  shareActive?: boolean;
  /** 加大版输入框(落地页「新对话」居中态用):输入区更高,留白更宽。 */
  large?: boolean;
  /** 变化时自动把光标聚焦到输入框(首页传 conversationId:点「新对话」/「助手」切到
   *  新会话、或切换会话后即可直接打字,省去再点一下)。同时作为「按会话草稿」的切换信号:
   *  focusKey 变 → 回填该会话草稿。 */
  focusKey?: string | null;
  /** 读取当前会话的输入框草稿(innerHTML);focusKey 变化时回填。省略=不做草稿持久化。 */
  readDraft?: () => string;
  /** 输入/发送时写回当前会话的草稿(innerHTML;发送后传 "")。与 readDraft 成对使用。 */
  writeDraft?: (html: string) => void;
}

const MAX = 4096;
const MAX_IMAGES = 3;

interface MentionTrigger {
  query: string;
  // The text-range covering the literal `@<query>` substring in the
  // editor — we use this on select to splice the chip in place of the
  // typed trigger characters.
  range: Range;
  // Caret rect in viewport coords. Both edges so the popover can flip
  // above the caret when the composer is near the viewport bottom.
  anchor: { left: number; caretTop: number; caretBottom: number };
}

interface ExtractedContent {
  text: string;
  mentions: { type: "doc" | "folder" | "role" | "skill"; id: string; label: string }[];
}

const ICON: Record<"doc" | "folder" | "role" | "skill", string> = {
  doc: "📄",
  folder: "📁",
  role: "👤",
  skill: "🧩",
};

// Walk the editor's child tree to assemble:
//   - text  — the plain-text the LLM sees; chips render as "@<label>"
//             so the inline mention reads naturally inside the question
//   - mentions — deduped {type,id,label} sidecar for the route handler
function extractContent(root: HTMLElement): ExtractedContent {
  const parts: string[] = [];
  const mentions: ExtractedContent["mentions"] = [];
  const seen = new Set<string>();
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.dataset.mentionId && node.dataset.mentionType && node.dataset.mentionLabel) {
        const type = node.dataset.mentionType as "doc" | "folder" | "role" | "skill";
        const id = node.dataset.mentionId;
        const label = node.dataset.mentionLabel;
        const key = `${type}:${id}`;
        if (!seen.has(key)) {
          mentions.push({ type, id, label });
          seen.add(key);
        }
        parts.push(`@${label}`);
        return;
      }
      if (node.nodeName === "BR") {
        parts.push("\n");
        return;
      }
    }
    node.childNodes.forEach(walk);
  }
  walk(root);
  return { text: parts.join(""), mentions };
}

// Look at the current selection; if the caret sits right after a
// `@<word>` token (with no whitespace breaking the run), return the
// query + a Range covering the trigger characters + a viewport anchor
// for the popover. Otherwise return null so the caller can hide the
// popover.
function detectMentionTrigger(root: HTMLElement): MentionTrigger | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  if (!root.contains(range.startContainer)) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  const offset = range.startOffset;
  const before = text.slice(0, offset);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) return null;
  const matchStart = before.length - m[0].length;
  const triggerRange = document.createRange();
  triggerRange.setStart(node, matchStart);
  triggerRange.setEnd(node, offset);

  // Anchor on caret rect — but a collapsed Range returns (0,0,0,0) in
  // Safari (and sometimes Firefox). Insert a temporary zero-width
  // marker span at the caret, measure ITS rect, then remove it. This
  // is stable across browsers + works inside chips/nested elements.
  // We capture BOTH the top and bottom of the caret line so the
  // popover can flip above when there's no room below.
  let anchor: { left: number; caretTop: number; caretBottom: number };
  const caretRect = range.getBoundingClientRect();
  if (caretRect.left !== 0 || caretRect.top !== 0) {
    anchor = { left: caretRect.left, caretTop: caretRect.top, caretBottom: caretRect.bottom };
  } else {
    const marker = document.createElement("span");
    // Width 0 so the marker doesn't visually move surrounding glyphs;
    // zero-width-space content gives the span a measurable position.
    marker.style.cssText = "display:inline-block;width:0;height:1em;";
    marker.textContent = "​";
    const r = range.cloneRange();
    r.collapse(true);
    r.insertNode(marker);
    const mr = marker.getBoundingClientRect();
    anchor = { left: mr.left, caretTop: mr.top, caretBottom: mr.bottom };
    marker.remove();
    // Restore the original caret position — inserting & removing the
    // marker can leave the selection on the now-empty parent.
    const restore = document.createRange();
    restore.setStart(node, offset);
    restore.collapse(true);
    sel.removeAllRanges();
    sel.addRange(restore);
  }
  return { query: m[1] ?? "", range: triggerRange, anchor };
}

// "Effectively empty" = no text, no chips. Browsers leave a stray
// `<br>` or `<p><br></p>` after the user backspaces everything which
// defeats the `:empty::before` placeholder selector. We normalize back
// to a truly empty host so the placeholder reappears.
function isEffectivelyEmpty(root: HTMLElement): boolean {
  if (root.childNodes.length === 0) return true;
  if ((root.textContent ?? "").trim().length > 0) return false;
  // No text, but might have meaningful chips. Walk for any
  // mention chip element.
  return !root.querySelector("[data-mention-id]");
}

export function ChatComposer({ onSend, disabled, onStop, headerSlot, onShare, shareActive, large, focusKey, readDraft, writeDraft }: Props) {
  const t = useT();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [mention, setMention] = useState<MentionTrigger | null>(null);
  // 待发送图片(已上传完成的 /uploads 视图);uploading 期间禁发,防半截发送。
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  // 点击缩略图放大预览(lightbox);Escape 或点遮罩关闭。
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const canSend = !disabled && !uploading && (hasContent || pendingImages.length > 0);

  // 会话切换(focusKey 变)/ 挂载时:① 回填该会话的输入框草稿(innerHTML,保留 @ 芯片),
  // 待发图片清空(防串台,本版不持久化图片);② 把光标落到输入框末尾(点「新对话」/「助手」/
  // 切会话即可直接打字)。草稿由输入时实时写回当前会话 runtime(见 handleInput),切走切回不丢不串台。
  // 仅依赖 focusKey:disabled 等变化不应重载草稿(否则会冲掉用户正在输入的内容)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = readDraft?.() ?? "";
    setPendingImages([]);
    refresh();
    if (disabled) return; // 生成中不抢焦点
    const raf = requestAnimationFrame(() => {
      el.focus();
      const sel = window.getSelection();
      if (sel) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    });
    return () => cancelAnimationFrame(raf);
  }, [focusKey]);

  // 轮次结束(disabled true→false)后把光标放回输入框,方便接着问。仅聚焦,不重载草稿
  // (与上面的会话切换 load 分开,避免 disabled 变化时冲掉用户正在输入的内容)。
  useEffect(() => {
    if (disabled) return;
    const el = editorRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(raf);
  }, [disabled]);

  // files 可来自 <input>(FileList)或粘贴/拖拽(File[]);两条入口都汇聚到这里,
  // 故粘贴的图片与「点按钮上传」共用同一套 pendingImages 状态与缩略图样式。
  async function pickImages(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    const room = MAX_IMAGES - pendingImages.length;
    if (room <= 0) { toast.error(t("chat.composer.maxImages", { n: MAX_IMAGES })); return; }
    const batch = Array.from(files).slice(0, room);
    setUploading(true);
    try {
      for (const f of batch) {
        const { url } = await api.uploads.image(f);
        setPendingImages((cur) => (cur.length < MAX_IMAGES ? [...cur, url] : cur));
      }
    } catch (e) {
      toast.error((e as Error).message || t("chat.composer.uploadFailed"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const refresh = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    // Placeholder fix: if the user backspaced down to a stray <br>,
    // reset the host so `:empty::before` matches again. Do this
    // BEFORE extractContent so the char count reflects the true zero.
    if (isEffectivelyEmpty(el) && el.innerHTML !== "") {
      el.innerHTML = "";
    }
    const { text, mentions } = extractContent(el);
    setHasContent(text.trim().length > 0 || mentions.length > 0);
    // 内容每次变化(输入/插芯片/删芯片/发送清空)都把草稿写回当前会话 runtime —— 单一落点,
    // 故切走切回不丢不串台,发送后 clearEditor→refresh 自动把草稿清空。回填时写回同会话原值=幂等。
    writeDraft?.(el.innerHTML);
  }, [writeDraft]);

  const clearEditor = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.innerHTML = "";
    refresh();
  }, [refresh]);

  function doSend() {
    if (!editorRef.current || !canSend) return;
    const { text, mentions } = extractContent(editorRef.current);
    const trimmed = text.trim();
    if (!trimmed && pendingImages.length === 0) return;
    // Truncating the text to MAX while keeping the FULL mentions array
    // silently expands server-side retrieval scope: a mention whose
    // `@<label>` anchor falls AFTER the cut is still sent even though
    // the user can no longer see it in the message. Truncate the text,
    // then drop any mention whose `@<label>` anchor no longer appears
    // within the surviving prefix so text + mentions stay consistent.
    const sliced = trimmed.slice(0, MAX);
    const keptMentions =
      sliced.length === trimmed.length
        ? mentions
        : mentions.filter((m) => sliced.includes(`@${m.label}`));
    onSend(sliced, keptMentions, pendingImages);
    clearEditor();
    setPendingImages([]);
    setMention(null);
  }

  function handleInput() {
    refresh();
    if (!editorRef.current) return;
    const t = detectMentionTrigger(editorRef.current);
    setMention(t);
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    // While the popover is open it owns ArrowUp/Down/Enter/Escape/Tab
    // for navigation — let those bubble down to its document-level
    // keydown listener and skip our own handling so we don't both
    // submit AND select.
    if (mention) {
      if (["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(e.key)) return;
    }

    // Cross-browser backspace fix: Chrome/Firefox treat a
    // `contenteditable="false"` chip as atomic and delete it whole on
    // Backspace. Safari (sometimes) drops the caret into the chip's
    // interior instead. If the caret sits IMMEDIATELY after a chip and
    // the user presses Backspace, explicitly remove the previous chip
    // node so the behavior is consistent.
    if (e.key === "Backspace" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        // We only care about the case where the caret is at the very
        // start of a text node, with a chip just before it. Other
        // cases let the browser's native backspace run.
        const node = range.startContainer;
        const offset = range.startOffset;
        let prevChip: HTMLElement | null = null;
        if (node.nodeType === Node.TEXT_NODE && offset === 0) {
          let prev = node.previousSibling;
          // Skip any zero-width text nodes between caret and chip.
          while (prev && prev.nodeType === Node.TEXT_NODE && (prev.textContent ?? "").length === 0) {
            prev = prev.previousSibling;
          }
          if (prev instanceof HTMLElement && prev.dataset.mentionId) prevChip = prev;
        } else if (node === editorRef.current && offset > 0) {
          const candidate = editorRef.current?.childNodes[offset - 1];
          if (candidate instanceof HTMLElement && candidate.dataset.mentionId) prevChip = candidate;
        }
        if (prevChip) {
          e.preventDefault();
          prevChip.remove();
          refresh();
          return;
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  }

  // Native paste of rich content would inject inline styles / fonts
  // that conflict with the chat bubble's typography and could even
  // smuggle in unwanted contenteditable elements. Strip to text/plain
  // every time — same convention as the AiBubble had before this
  // rewrite (textarea ignored HTML anyway).
  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    // 先看剪贴板里有没有图片(截图 / 复制图片文件)。有则走与「点按钮上传」完全
    // 相同的 pickImages 流程 → 进 pendingImages,缩略图/预览/删除样式一致。
    // 图片可能落在 clipboardData.files,也可能只在 items 里(kind==="file"),两处都取。
    const clip = e.clipboardData;
    const imageFiles: File[] = [];
    for (const item of Array.from(clip.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) {
      for (const f of Array.from(clip.files)) {
        if (f.type.startsWith("image/")) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      // 有图片就当作图片粘贴:阻止默认(避免把图片文件名/富文本插进编辑区),
      // 忽略同时携带的文本,与手动上传语义一致。
      e.preventDefault();
      void pickImages(imageFiles);
      return;
    }

    e.preventDefault();
    const text = clip.getData("text/plain");
    if (!text) return;
    // Insert at caret. execCommand is deprecated but still the most
    // reliable cross-browser way to insert into a contentEditable;
    // Selection API alternative below as fallback.
    if (document.execCommand) {
      document.execCommand("insertText", false, text);
    } else {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      sel.collapseToEnd();
    }
    refresh();
  }

  // Lightbox 打开期间监听 Escape 关闭。注意:文件顶部 import 的 KeyboardEvent
  // 是 React 合成事件类型,这里是 document 级原生事件,须用 globalThis 限定。
  useEffect(() => {
    if (!previewUrl) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setPreviewUrl(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previewUrl]);

  // Re-render dependency: chips don't trigger React renders (they're
  // raw DOM), so we need an `input` handler to refresh state. Some
  // platforms also fire `compositionend` after IME (Chinese input)
  // completes without an `input` event — listen for both.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    function onCompositionEnd() { refresh(); }
    el.addEventListener("compositionend", onCompositionEnd);
    return () => el.removeEventListener("compositionend", onCompositionEnd);
  }, [refresh]);

  // Highlight the entire chip pill (rounded background + glyphs) when
  // its text is inside the current selection. Without this, only the
  // glyph backgrounds inside the chip get the `::selection` violet —
  // the pill's own padding area stays the default violet/10 fill and
  // visually the chip doesn't read as "selected as one object".
  //
  // Mechanism: listen to `selectionchange` at document level; for each
  // chip in the editor check `selection.containsNode(chip, false)` and
  // toggle a class accordingly. The CSS for `.tm-mention-chip-selected`
  // overrides background + adds a ring so the whole pill stands out.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    function onSelectionChange() {
      const host = editorRef.current;
      if (!host) return;
      const sel = window.getSelection();
      const chips = host.querySelectorAll<HTMLElement>(".tm-mention-chip");
      chips.forEach((chip) => {
        const isSelected = !!(sel && sel.containsNode && sel.containsNode(chip, false));
        chip.classList.toggle("tm-mention-chip-selected", isSelected);
      });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  function onMentionSelect(item: ChatMentionItem) {
    const el = editorRef.current;
    if (!el || !mention) return;
    // Delete the `@<query>` characters and insert a chip + trailing
    // non-breaking space (so the caret has somewhere to live after
    // the atomic chip element).
    mention.range.deleteContents();
    // Skills render as "<角色>Skill" in the box (e.g. 产品Skill) so the chip
    // reads as a skill, not a plain role mention. The picker list rows stay as
    // clean role names. The server re-derives the snapshot label from the DB,
    // so this display label only affects the composer chip + the inline @text.
    const displayLabel = item.type === "skill" ? `${item.label}Skill` : item.label;
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.mentionType = item.type;
    chip.dataset.mentionId = item.id;
    chip.dataset.mentionLabel = displayLabel;
    chip.className = "tm-mention-chip";
    chip.textContent = `${ICON[item.type]} ${displayLabel}`;
    mention.range.insertNode(chip);
    const space = document.createTextNode(" ");
    chip.after(space);
    // Restore caret to AFTER the trailing space.
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(space);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    setMention(null);
    refresh();
    el.focus();
  }

  return (
    <div className="p-5">
      {/* 输入框外框:边框/圆角/底色在 wrapper 上(focus-within 替代原来编辑区的
          focus 描边),这样「待发送图片行」位于输入框内部、独占一行;编辑区与
          发送/选图按钮、字数计数仍绝对定位在框内。 */}
      <div
        className={cn(
          "relative rounded-lg border border-line bg-white focus-within:border-primary",
          disabled && "bg-surface",
        )}
      >
        {/* 待发送图片行(输入框内第一行):缩略图点击放大预览,✕ 删除;
            uploading 时尾部加一个加载占位。 */}
        {(pendingImages.length > 0 || uploading) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line/60 px-5 pb-3 pt-4">
            {pendingImages.map((url) => (
              <div key={url} className="relative h-14 w-14 overflow-hidden rounded-lg border border-line bg-surface">
                <button
                  type="button"
                  aria-label={t("chat.composer.previewImage")}
                  title={t("chat.composer.clickPreview")}
                  onClick={() => setPreviewUrl(url)}
                  className="block h-full w-full cursor-zoom-in"
                >
                  <img src={uploadSrc(url)} alt={t("chat.composer.pendingImageAlt")} className="h-full w-full object-cover" />
                </button>
                <button
                  type="button"
                  aria-label={t("chat.composer.removeImage")}
                  title={t("chat.composer.removeImage")}
                  onClick={() => setPendingImages((cur) => cur.filter((u) => u !== url))}
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] leading-none text-white hover:bg-black/80"
                >
                  ✕
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted">
                {t("chat.composer.uploading")}
              </div>
            )}
          </div>
        )}
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={t("chat.composer.askAria", { name: getAssistantName() })}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          data-placeholder={t("chat.composer.placeholder", { name: getAssistantName() })}
          className={cn(
            "tm-chat-editor w-full resize-none bg-transparent text-sm outline-none",
            "max-h-[18rem] overflow-y-auto whitespace-pre-wrap break-words",
            // 加大版:更高的输入区 + 更宽的内边距(落地页居中态);常规版保持原尺寸。
            large ? "min-h-[9.5rem] px-6 pt-6 pb-2" : "min-h-[6rem] px-5 pt-5 pb-2",
            disabled && "text-muted",
          )}
        />
        {/* 隐藏的 file input,由工具条里的选图按钮代理。 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(e) => void pickImages(e.target.files)}
        />
        {/* 底部工具条:左 = 专家选择条(headerSlot,点击向上弹复选框);
            右 = 插图按钮 + 发送/停止(插图在发送左侧)。WorkBuddy 式排版。 */}
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
          <div className="flex min-w-0 flex-1 items-center">{headerSlot}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading || pendingImages.length >= MAX_IMAGES}
              aria-label={t("chat.composer.uploadImage")}
              title={pendingImages.length >= MAX_IMAGES ? t("chat.composer.maxImagesShort", { n: MAX_IMAGES }) : t("chat.composer.uploadImageTip", { name: getAssistantName() })}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition",
                disabled || uploading || pendingImages.length >= MAX_IMAGES
                  ? "text-muted/50 cursor-not-allowed"
                  : "text-muted hover:bg-surface hover:text-primary active:scale-95",
              )}
            >
              {/* 图片图标(山+太阳) */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* 多选分享:进入多选模式挑消息 → 生成图片 / 分享到文档。位于发送键左侧。 */}
            {onShare && (
              <button
                type="button"
                onClick={onShare}
                aria-label={t("chat.composer.multiShare")}
                title={t("chat.composer.multiShareTip")}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg transition active:scale-95",
                  shareActive ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface hover:text-primary",
                )}
              >
                {/* 分享/上传箭头出框 */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                  <polyline points="8 7 12 3 16 7" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            )}
            {disabled && onStop ? (
              // In-flight: 发送按钮变停止键。点击 → onStop(中止上游 stream + 清 store 态)。
              <button
                type="button"
                onClick={onStop}
                aria-label={t("chat.composer.stop")}
                title={t("chat.composer.stop")}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500 text-white shadow-glass transition hover:bg-rose-500/90 active:scale-95"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={doSend}
                disabled={!canSend}
                aria-label={t("chat.composer.send")}
                title={t("chat.composer.sendTip")}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg transition",
                  canSend
                    ? "bg-primary text-primary-fg shadow-glass hover:bg-primary/90 active:scale-95"
                    : "bg-surface text-muted cursor-not-allowed",
                )}
              >
                {/* Upward arrow — same metaphor as ChatGPT / Claude send. */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {mention && (
        <ChatMentionPopover
          query={mention.query}
          anchor={mention.anchor}
          onSelect={onMentionSelect}
          onClose={() => setMention(null)}
        />
      )}
      {/* 图片预览 lightbox:点遮罩 / ✕ / Escape 关闭;点图片本身不关闭。 */}
      {previewUrl && (
        <div
          role="dialog"
          aria-label={t("chat.composer.imagePreview")}
          onClick={() => setPreviewUrl(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
        >
          <img
            src={uploadSrc(previewUrl)}
            alt={t("chat.composer.imagePreview")}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-pop"
          />
          <button
            type="button"
            aria-label={t("chat.composer.closePreview")}
            onClick={() => setPreviewUrl(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-base text-white hover:bg-black/70"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
