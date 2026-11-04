import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { CommentRow } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/cn";
import { UserName } from "@/components/UserName";
import { CommentMentionField, renderCommentBody, mentionsToPlain, type CommentFieldHandle } from "./CommentMentionField";
import { useT } from "@/i18n";

interface Props {
  articleId: string;
  onCountChange?: (n: number) => void;
}

export interface CommentSectionHandle {
  /** Scroll the section into view + focus the input. Wired to the
   *  action sidebar's comment button. */
  focus: () => void;
}

// Total comment count = top-level + every reply (so the "评论 (N)"
// header and the article action bar match what the user actually sees).
function flatCount(rows: CommentRow[]): number {
  let n = 0;
  for (const c of rows) n += 1 + flatCount(c.replies);
  return n;
}

export const CommentSection = forwardRef<CommentSectionHandle, Props>(function CommentSection(
  { articleId, onCountChange },
  ref,
) {
  const t = useT();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);
  // Deep-link target: a notification card links to /d/:id#comment-:cid. Once
  // comments load, scroll the linked comment into view and flash a ring.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const location = useLocation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<CommentFieldHandle | null>(null);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  useImperativeHandle(ref, () => ({
    focus: () => {
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => inputRef.current?.focus(), 200);
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.comments.list(articleId);
        if (cancelled) return;
        setComments(res.comments);
        onCountChangeRef.current?.(flatCount(res.comments));
      } catch (err) {
        if (!cancelled) toast.error(t("article.comments.loadFailed", { msg: (err as Error).message }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [articleId]);

  // After comments render, honor a #comment-<id> hash (notification deep link):
  // scroll it into view + flash a ring for ~2s. No-op if the comment isn't on
  // the loaded page or the hash is absent.
  useEffect(() => {
    if (loading) return;
    // Use the router location's hash (not window.location) + depend on it, so
    // clicking a SECOND notification for the already-loaded article re-fires the
    // scroll/highlight — React Router pushState doesn't emit a `hashchange`.
    const m = location.hash.match(/^#comment-(.+)$/);
    if (!m) return;
    const id = m[1]!;
    const el = document.getElementById(`comment-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    const t = window.setTimeout(() => setHighlightId(null), 2000);
    return () => window.clearTimeout(t);
  }, [loading, comments, location.hash]);

  async function submitTopLevel() {
    const body = draft.trim();
    if (body.length === 0 || posting) return;
    setPosting(true);
    try {
      const res = await api.comments.add(articleId, body);
      setComments((prev) => {
        const next = [...prev, res.comment];
        onCountChangeRef.current?.(flatCount(next));
        return next;
      });
      inputRef.current?.clear(); // clears the editor + resets draft via onChange
      toast.success(t("article.comments.posted"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPosting(false);
    }
  }

  async function submitReply(parentId: string, body: string) {
    const res = await api.comments.add(articleId, body, parentId);
    setComments((prev) => {
      // 多级回复:沿树递归找到被回复的节点,把新回复挂到它的 replies 尾部
      // (与服务端 GET 的「按直接父建树、时间升序」一致)。
      const appendReply = (rows: CommentRow[]): CommentRow[] =>
        rows.map((c) =>
          c.id === parentId
            ? { ...c, replies: [...c.replies, res.comment] }
            : { ...c, replies: appendReply(c.replies) },
        );
      const next = appendReply(prev);
      onCountChangeRef.current?.(flatCount(next));
      return next;
    });
  }

  async function remove(id: string) {
    const ok = await dialog.confirm(t("article.comments.confirmDelete"), { confirmText: t("common.delete"), danger: true });
    if (!ok) return;
    try {
      await api.comments.remove(id);
      setComments((prev) => {
        // 树形结构:摘掉该节点即连同其整棵子树消失(服务端 FK Cascade
        // 同步级联删除子孙)。
        const removeNode = (rows: CommentRow[]): CommentRow[] =>
          rows.filter((c) => c.id !== id).map((c) => ({ ...c, replies: removeNode(c.replies) }));
        const next = removeNode(prev);
        onCountChangeRef.current?.(flatCount(next));
        return next;
      });
      toast.success(t("article.comments.deleted"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Optimistic-style: hit the API, patch the matching row with the
  // returned count. Locates the row whether it's top-level or nested
  // under a parent.
  async function toggleLike(id: string, currentlyLiked: boolean) {
    try {
      const res = currentlyLiked
        ? await api.comments.unlike(id)
        : await api.comments.like(id);
      const patch = (rows: CommentRow[]): CommentRow[] =>
        rows.map((c) =>
          c.id === id
            ? { ...c, isLiked: res.isLiked, likeCount: res.likeCount }
            : { ...c, replies: patch(c.replies) },
        );
      setComments((prev) => patch(prev));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const total = flatCount(comments);
  // Counter shows VISIBLE length — mention chips count as "@name", not the full
  // [@name](/u/id) marker — so it tracks what the user sees, not the markdown.
  const draftVisibleLen = mentionsToPlain(draft).length;

  // 飞书:评论区去掉外框 —— 不再是卡片,只用一条上分隔线与正文区隔。
  return (
    <section ref={rootRef} className="border-t border-line pt-6">
      <h2 className="text-base font-semibold">
        {t("article.comments.title")} <span className="ml-1 text-sm font-normal text-muted">({total})</span>
      </h2>

      <div className="mt-4 flex flex-col gap-2">
        <CommentMentionField
          ref={inputRef}
          onChange={setDraft}
          onSubmitShortcut={() => void submitTopLevel()}
          placeholder={t("article.comments.placeholder")}
          className="min-h-[4.5rem] w-full rounded-lg border border-line bg-bg/50 px-3 py-2 text-sm focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{draftVisibleLen}/4000</span>
          <Button size="sm" onClick={submitTopLevel} disabled={draft.trim().length === 0 || posting}>
            {posting ? t("article.comments.sending") : t("article.comments.send")}
          </Button>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {loading && <div className="text-sm text-muted">{t("common.loading")}</div>}
        {!loading && comments.length === 0 && (
          <div className="text-sm text-muted">{t("article.comments.empty")}</div>
        )}
        {comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            onLike={toggleLike}
            onReply={submitReply}
            onDelete={remove}
            highlightId={highlightId}
          />
        ))}
      </div>
    </section>
  );
});

// 缩进封顶层级:回复逐级向右缩进,超过该深度后不再继续缩进(防窄栏
// 挤爆),改为同级平铺 + 「回复 @某人:原文摘要」引用行标出对话对象。
const MAX_INDENT_DEPTH = 3;

// 引用行摘要:提及标记 [@name](/u/id) 还原成 @name,折叠换行,截断。
function quoteExcerpt(body: string): string {
  const plain = mentionsToPlain(body)
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
}

function CommentItem({
  comment, onLike, onReply, onDelete, depth = 0, highlightId = null, quote = null,
}: {
  comment: CommentRow;
  onLike: (id: string, currentlyLiked: boolean) => void | Promise<void>;
  onReply: (parentId: string, body: string) => Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  /** 0 = 顶层评论;每深一级 +1,渲染端据此决定是否继续缩进。 */
  depth?: number;
  highlightId?: string | null;
  /** 缩进封顶后被平铺的回复:带上被回复者与其原文摘要(否则看不出回的是谁/啥)。 */
  quote?: { name: string; body: string } | null;
}) {
  const t = useT();
  const isReply = depth > 0;
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPosting, setReplyPosting] = useState(false);

  async function submitReply() {
    const body = replyDraft.trim();
    if (body.length === 0 || replyPosting) return;
    setReplyPosting(true);
    try {
      await onReply(comment.id, body);
      setReplyDraft("");
      setReplyOpen(false);
      toast.success(t("article.comments.replyPosted"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setReplyPosting(false);
    }
  }

  return (
    <div
      id={`comment-${comment.id}`}
      className={cn(
        // Card surface — border + light grey background lifts comments
        // off the parent section so each thread reads as its own unit.
        "scroll-mt-20 rounded-lg border border-line bg-surface/60 px-4 py-3 transition",
        isReply ? "" : "hover:border-primary/30",
        highlightId === comment.id && "ring-2 ring-primary/50",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">
          <UserName userId={comment.author?.id} name={comment.author?.displayName ?? t("article.deletedUser")} />
        </div>
        <div className="text-xs text-muted">{formatTimestamp(comment.createdAt)}</div>
      </div>
      {quote && (
        <div className="mt-1 truncate rounded border-l-2 border-line bg-surface px-2 py-1 text-xs text-muted">
          {t("article.comments.replyQuote", { name: quote.name, excerpt: quoteExcerpt(quote.body) })}
        </div>
      )}
      <p className="mt-1 whitespace-pre-wrap text-sm text-fg/85">{renderCommentBody(comment.body)}</p>
      <div className="mt-2 flex items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => void onLike(comment.id, comment.isLiked)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 transition",
            comment.isLiked ? "text-primary bg-blue-50" : "text-muted hover:text-primary hover:bg-blue-50",
          )}
          aria-pressed={comment.isLiked}
          aria-label={comment.isLiked ? t("article.comments.unlike") : t("article.comments.like")}
        >
          <HeartIcon filled={comment.isLiked} />
          {comment.likeCount > 0 && <span>{comment.likeCount}</span>}
        </button>
        {/* 任意评论(含回复)都可继续回复 —— 逻辑层级不限;展示保持平铺
            (新回复进同一个顶层桶,带「回复 @某人」标记),不会深层缩进。 */}
        <button
          type="button"
          onClick={() => setReplyOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted transition hover:text-primary hover:bg-blue-50"
        >
          <ReplyIcon />
          <span>{t("article.comments.reply")}</span>
        </button>
        {comment.canDelete && (
          <button
            type="button"
            onClick={() => void onDelete(comment.id)}
            className="ml-auto rounded-md px-2 py-1 text-muted/70 transition hover:bg-rose-50 hover:text-rose-500"
          >
            {t("common.delete")}
          </button>
        )}
      </div>

      {replyOpen && (
        <div className="mt-3 flex flex-col gap-2">
          <CommentMentionField
            onChange={setReplyDraft}
            onSubmitShortcut={() => void submitReply()}
            placeholder={t("article.comments.replyPlaceholder", { name: comment.author?.displayName ?? "..." })}
            className="min-h-[3rem] w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setReplyOpen(false); setReplyDraft(""); }}
              disabled={replyPosting}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={submitReply}
              disabled={replyDraft.trim().length === 0 || replyPosting}
            >
              {replyPosting ? t("article.comments.sending") : t("article.comments.send")}
            </Button>
          </div>
        </div>
      )}

      {comment.replies.length > 0 && (
        // 逐级缩进到 MAX_INDENT_DEPTH 封顶:更深的回复不再缩进(同级平铺),
        // 由 quote 引用行标出它回的是谁、回的什么。
        <div className={cn("mt-3 flex flex-col gap-2", depth < MAX_INDENT_DEPTH && "border-l-2 border-line pl-3")}>
          {comment.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              onLike={onLike}
              onReply={onReply}
              onDelete={onDelete}
              depth={depth + 1}
              highlightId={highlightId}
              quote={
                depth + 1 > MAX_INDENT_DEPTH
                  ? { name: comment.author?.displayName ?? t("article.deletedUser"), body: comment.body }
                  : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}
