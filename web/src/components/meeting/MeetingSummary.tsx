import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderVisibility, MeetingDetailResponse, MeetingSessionRow } from "@team-knowledge/shared";
import { isMeetingSummaryFailure } from "@team-knowledge/shared";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { api, ApiError, API_BASE } from "@/lib/api";
import { fmtDateTime } from "@/lib/relativeTime";
import { toast } from "@/components/Toaster";
import { cn } from "@/lib/cn";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { beijingParts } from "@/lib/tz";
import { AssistantPanel } from "./AssistantPanel";
import { getAssistantName } from "@/lib/assistantName";

// ─── Post-meeting summary view ────────────────────────────
// Rendered by MeetingRoomPage when session.status === "ended".
// Three async layers stacked vertically:
//   1. Header — title + duration + meta
//   2. Recording playback (if recordingUrl is set)
//   3. Generated summary (markdown). While generating, shows
//      a polling placeholder; admin can manually re-trigger.
//   4. assistant comment timeline (read-only AssistantPanel)
//   5. Expandable transcript
// Plus an admin-only "📥 保存到知识库" footer.

const SUMMARY_POLL_INTERVAL_MS = 4_000;
const SUMMARY_POLL_TIMEOUT_MS = 90_000;
// How many times we silently re-trigger summary generation after a
// failure/timeout before falling back to the manual retry block. The
// counter only resets when a fresh real summary lands, so a stuck
// session can never loop forever.
const MAX_AUTO_RETRIES = 2;

interface Props {
  detail: MeetingDetailResponse;
  /** Whether the viewer can see the admin-only save-to-KB footer. */
  canArchive: boolean;
  /** Called whenever we re-fetch the session (e.g. polling for
   *  summary completion or after save-to-KB). Parent uses this to
   *  refresh its own copy of the detail. */
  onRefresh: () => Promise<void> | void;
}

export function MeetingSummary({ detail, canArchive, onRefresh }: Props) {
  const session = detail.session;
  const summaryFailed = isMeetingSummaryFailure(session.summaryMarkdown);
  // The polling loop should keep running while we don't yet have a
  // real summary (null) OR we have a failure marker that the user
  // could retry away. Once a real markdown is in place, no polling.
  const hasRealSummary = !!session.summaryMarkdown && !summaryFailed;

  // Polling loop. The `pollGeneration` counter is the linchpin for
  // retry: after a failed retry round-trip the user clicks again
  // and we want a fresh `startedAt`, not the original mount's
  // timestamp (which would already be past the 90s budget).
  const [pollingExpired, setPollingExpired] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  // Auto-retry bookkeeping. `autoRetryCountRef` survives re-renders so we
  // never re-trigger generation more than MAX_AUTO_RETRIES times; the
  // counter resets to 0 only when a fresh real summary lands (effect
  // below). `autoRetrying` drives the "正在自动重试…(n/2)" UI so the
  // failure block stays hidden until the cap is exhausted.
  const autoRetryCountRef = useRef(0);
  const [autoRetrying, setAutoRetrying] = useState(false);
  // Keep `onRefresh` reachable inside the interval without making
  // the effect re-mount every time the parent re-renders. The parent
  // memoizes it via useCallback today, but this ref pattern keeps
  // the effect robust if that ever changes.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // Dedupe overlapping refreshes. The polling effect (every 4s) and the
  // auto-retry effect (which also refreshes after regenerate) could
  // otherwise issue concurrent reload()s; coalesce them through a single
  // in-flight guard so only one refresh runs at a time. `regenInFlight`
  // additionally blocks a second regenerate while one is still running.
  const refreshInFlightRef = useRef(false);
  const regenInFlightRef = useRef(false);
  // Skip a refresh if one is already running (a poll tick that lands
  // while a regenerate-triggered refresh is in flight is redundant).
  const refreshOnce = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try { await onRefreshRef.current(); }
    finally { refreshInFlightRef.current = false; }
  }, []);

  // Shared regenerate trigger — used by BOTH the manual retry button and
  // the auto-retry effect. Bumps the generation counter so the polling
  // effect re-mounts with a fresh `startedAt` if regeneration also fails
  // and we fall back to spinner mode.
  const triggerRegenerate = useCallback(async (opts?: { silent?: boolean }) => {
    // Don't fire a second regenerate while one is in flight — overlapping
    // POST /summary calls race each other and waste an LLM round-trip.
    if (regenInFlightRef.current) return;
    regenInFlightRef.current = true;
    setPollingExpired(false);
    setPollGeneration((g) => g + 1);
    try {
      await api.meeting.regenerateSummary(session.id);
      if (!opts?.silent) toast.success("已重新触发纪要生成");
      await refreshOnce();
    } finally {
      regenInFlightRef.current = false;
    }
  }, [session.id, refreshOnce]);

  // Reset the auto-retry budget once a real summary is in place, so a
  // future re-failure (e.g. after an edit/regenerate) gets its own
  // fresh allowance instead of inheriting an exhausted counter.
  useEffect(() => {
    if (hasRealSummary) {
      autoRetryCountRef.current = 0;
      setAutoRetrying(false);
    }
  }, [hasRealSummary]);

  // Auto-retry loop. When generation has failed or the poll timed out and
  // we still don't have a real summary, silently re-trigger generation up
  // to MAX_AUTO_RETRIES times before surfacing the manual retry block.
  useEffect(() => {
    if (hasRealSummary || session.status !== "ended") return;
    const failedOrExpired = summaryFailed || pollingExpired;
    if (!failedOrExpired) return;
    if (autoRetryCountRef.current >= MAX_AUTO_RETRIES) {
      setAutoRetrying(false);
      return;
    }
    let alive = true;
    autoRetryCountRef.current += 1;
    setAutoRetrying(true);
    (async () => {
      try {
        await triggerRegenerate({ silent: true });
      } catch {
        // Swallow — a failed auto-retry just leaves us in the
        // failed/expired state, which re-runs this effect (and either
        // retries again or, once the cap is hit, shows manual retry).
      } finally {
        if (alive) setAutoRetrying(false);
      }
    })();
    return () => { alive = false; };
  }, [hasRealSummary, summaryFailed, pollingExpired, session.status, triggerRegenerate]);

  useEffect(() => {
    if (hasRealSummary || session.status !== "ended") return;
    // Failure-marker case: the row already says "we tried + failed".
    // No point auto-polling for a different answer; the user has to
    // click retry. Surface the expired state immediately so the UI
    // shows the retry block, skipping the 90s spinner.
    if (summaryFailed) {
      setPollingExpired(true);
      return;
    }
    setPollingExpired(false);
    let alive = true;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      if (!alive) return;
      if (Date.now() - startedAt > SUMMARY_POLL_TIMEOUT_MS) {
        window.clearInterval(tick);
        setPollingExpired(true);
        return;
      }
      // refreshOnce coalesces with any regenerate-triggered refresh that's
      // still in flight, so polling can't pile a second reload() on top.
      void refreshOnce();
    }, SUMMARY_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(tick);
    };
  }, [hasRealSummary, summaryFailed, session.status, pollGeneration, refreshOnce]);

  // title→articleId from the meeting's assistant-comment citations, so the summary's
  // 《文档名》 mentions can be linked (the LLM summary text only has titles).
  const docLinkByTitle = buildDocLinkMap(detail.comments);

  return (
    <div className="flex flex-col gap-4">
      <SummaryMeta session={session} />
      {/* canArchive == isHost || isAdmin == who may edit meeting metadata. */}
      <VisibilityControl session={session} canEdit={canArchive} onChanged={onRefresh} />
      {session.recordingUrl && <RecordingPlayer url={session.recordingUrl} />}
      <CollapsibleSection title="会议纪要" defaultOpen>
        <SummaryBlock
          session={session}
          docLinks={docLinkByTitle}
          summaryFailed={summaryFailed}
          pollingExpired={pollingExpired}
          autoRetrying={autoRetrying}
          autoRetryAttempt={autoRetryCountRef.current}
          maxAutoRetries={MAX_AUTO_RETRIES}
          onRetry={async () => {
            try {
              await triggerRegenerate();
            } catch (e) {
              toast.error(e instanceof ApiError ? e.message : (e as Error).message);
            }
          }}
        />
      </CollapsibleSection>
      {detail.comments.length > 0 && (
        <CollapsibleSection title={`${getAssistantName()} 评论`} count={detail.comments.length} defaultOpen>
          <AssistantPanel
            comments={detail.comments}
            startedAtMs={new Date(session.createdAt).getTime()}
            lastSkipped={null}
            onAsk={() => { /* read-only */ }}
            isHost={false}
            readOnly
          />
        </CollapsibleSection>
      )}
      {detail.transcripts.length > 0 && (
        <CollapsibleSection title={`完整转录（${detail.transcripts.length} 段）`}>
          <TranscriptList transcripts={detail.transcripts} startedAtMs={new Date(session.createdAt).getTime()} />
        </CollapsibleSection>
      )}
      {canArchive && hasRealSummary && (
        <SaveToKBPanel sessionId={session.id} allowedRoleIds={session.allowedRoleIds} allowedRoles={session.allowedRoles} />
      )}
    </div>
  );
}

// Reusable collapsible card — a full-width header button with an optional
// count chip and a CollapseChevron that rotates when open. Modeled on the old
// TranscriptCollapsible toggle; the three post-meeting sections (会议纪要,
//助手评论, 完整转录) now share it so they expand/collapse identically.
function CollapsibleSection({
  title, count, defaultOpen = false, children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-sm font-semibold text-fg"
      >
        <span className="flex items-center gap-2">
          <span>{title}</span>
          {count !== undefined && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{count}</span>
          )}
        </span>
        <CollapseChevron open={open} />
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

// Visibility scope display + (for creator/admin) editor. Optimistic toggle
// backed by PATCH /api/meeting/:id, then onChanged() re-fetches the detail.
// Exported for unit testing.
export function VisibilityControl({
  session, canEdit, onChanged,
}: { session: MeetingSessionRow; canEdit: boolean; onChanged: () => Promise<void> | void }) {
  const [vis, setVis] = useState<FolderVisibility>(session.visibility);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVis(session.visibility); }, [session.visibility]);

  if (!canEdit) {
    return (
      <div className="text-xs text-muted">
        可见性：{session.visibility === "private" ? "🔒 私密（仅主持人可见）" : "🌐 公开（所有成员可见）"}
      </div>
    );
  }

  async function set(next: FolderVisibility) {
    if (next === vis || saving) return;
    const prev = vis;
    setVis(next); // optimistic
    setSaving(true);
    try {
      await api.meeting.update(session.id, { visibility: next });
      toast.success(next === "private" ? "已设为私密" : "已设为公开");
      await onChanged();
    } catch (e) {
      setVis(prev); // rollback
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">可见性</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-line">
        {(["public", "private"] as const).map((v) => (
          <button
            key={v}
            type="button"
            disabled={saving}
            onClick={() => void set(v)}
            className={cn(
              "px-2.5 py-1 transition disabled:opacity-60",
              vis === v ? "bg-primary text-primary-fg" : "bg-white text-muted hover:bg-surface",
            )}
          >
            {v === "public" ? "🌐 公开" : "🔒 私密"}
          </button>
        ))}
      </div>
    </div>
  );
}

function SummaryMeta({ session }: { session: MeetingSessionRow }) {
  const minutes = session.endedAt
    ? Math.max(1, Math.round((new Date(session.endedAt).getTime() - new Date(session.createdAt).getTime()) / 60_000))
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span>主持人：{session.hostName}</span>
      <span>开始：{fmtDateTime(session.createdAt)}</span>
      {session.endedAt && (
        <>
          <span>结束：{fmtDateTime(session.endedAt)}</span>
        </>
      )}
      {minutes !== null && (
        <>
          <span>{minutes} 分钟</span>
        </>
      )}
      <span>关联角色：{session.allowedRoles.map((r) => r.name).join(" / ") || "（无）"}</span>
    </div>
  );
}

function RecordingPlayer({ url }: { url: string }) {
  // The server returns a root-relative path (/meeting-recordings/<id>.wav). It
  // must be fetched through the gateway's API base (/…/api) — rendered raw it
  // resolves to the SITE root and 404s (blank player + failed download).
  const src = `${API_BASE}${url}`;
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
        <span aria-hidden>🎧</span>
        <span>会议录音</span>
      </div>
      <audio controls src={src} className="w-full" preload="metadata" />
      {/* ?download=1 → server responds attachment with the meeting title as the
          filename (instead of the opaque cuid). Playback above stays inline. */}
      <a
        href={`${src}?download=1`}
        download
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-fg/80 shadow-glass transition hover:bg-surface"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        下载录音文件
      </a>
    </div>
  );
}

// Build a title→articleId lookup from the meeting's assistant-comment citations
// (first occurrence wins on duplicate titles).
function buildDocLinkMap(comments: MeetingDetailResponse["comments"]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of comments) {
    for (const r of c.citedRefs) if (r.title && !m.has(r.title)) m.set(r.title, r.articleId);
  }
  return m;
}

// Turn 《文档名》 whose title matches a cited doc into a markdown link (/d/:id),
// which ChatMarkdown renders as a clickable anchor. Titles containing markdown
// link metacharacters are skipped (they'd break the [..](..) we'd emit), and
// non-matching 《…》 (generic phrases) are left untouched.
function linkifyDocRefs(md: string, byTitle: Map<string, string>): string {
  if (byTitle.size === 0) return md;
  return md.replace(/《([^》\n]+)》/g, (full, title: string) => {
    const id = byTitle.get(title.trim());
    return id && !/[[\]()]/.test(title) ? `[《${title}》](/d/${id})` : full;
  });
}

function SummaryBlock({
  session, docLinks, summaryFailed, pollingExpired, autoRetrying, autoRetryAttempt, maxAutoRetries, onRetry,
}: {
  session: MeetingSessionRow;
  docLinks: Map<string, string>;
  summaryFailed: boolean;
  pollingExpired: boolean;
  /** True while an automatic regenerate round-trip is in flight. */
  autoRetrying: boolean;
  /** Which auto-retry attempt is showing (1-based), for the "(n/2)" hint. */
  autoRetryAttempt: number;
  maxAutoRetries: number;
  onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);

  // Real markdown — render it directly. We checked summaryFailed
  // upstream so we never get here with a sentinel string that would
  // leak the internal marker into the page.
  if (session.summaryMarkdown && !summaryFailed) {
    return <ChatMarkdown text={linkifyDocRefs(session.summaryMarkdown, docLinks)} refs={[]} />;
  }
  // Auto-retry in flight (or queued before the cap is exhausted) — show
  // the auto-retry state instead of the manual failure block.
  if (autoRetrying) {
    return (
      <div className="text-center text-sm text-muted">
        <div className="text-2xl animate-pulse">🔁</div>
        <div className="mt-2 font-medium text-fg">正在自动重试…({autoRetryAttempt}/{maxAutoRetries})</div>
        <p className="mt-1 text-xs">纪要生成失败，正在自动重新生成。</p>
      </div>
    );
  }
  // Either we're still polling (null + not expired) or we have a
  // failure / timeout that the user can retry. Only show the manual
  // retry block once the auto-retry budget is spent.
  const showRetry = pollingExpired || summaryFailed;
  return (
    <div className="text-center text-sm text-muted">
      {showRetry ? (
        <>
          <div className="text-2xl">{summaryFailed ? "⚠️" : "⏱️"}</div>
          <div className="mt-2 font-medium text-fg">
            {summaryFailed ? "纪要生成失败" : "纪要生成超时"}
          </div>
          <p className="mt-1 text-xs">
            {summaryFailed
              ? "LLM 返回了空内容或异常。点击重试 ↓"
              : "LLM 没有在 90 秒内返回结果。点击重试 ↓"}
          </p>
          <button
            type="button"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              try { await onRetry(); }
              finally { setRetrying(false); }
            }}
            className="mt-3 rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-fg transition hover:bg-surface disabled:opacity-60"
          >
            {retrying ? "重新触发中…" : "🔁 重新生成纪要"}
          </button>
        </>
      ) : (
        <>
          <div className="text-2xl animate-pulse">🤖</div>
          <div className="mt-2 font-medium text-fg">{getAssistantName()} 正在生成纪要…</div>
          <p className="mt-1 text-xs">这通常需要 10-30 秒。页面会自动刷新。</p>
        </>
      )}
    </div>
  );
}

function TranscriptList({ transcripts, startedAtMs }: { transcripts: MeetingDetailResponse["transcripts"]; startedAtMs: number }) {
  return (
    <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
      {transcripts.map((t) => (
        // content-visibility:auto lets the browser skip layout/paint for rows
        // scrolled out of view — cheap virtualization for a full (uncapped)
        // transcript without a windowing lib. containIntrinsicSize reserves a
        // placeholder height so the scrollbar stays stable.
        <div
          key={t.id}
          className="mb-1 flex gap-2"
          style={{ contentVisibility: "auto", containIntrinsicSize: "auto 28px" }}
        >
          <span className="shrink-0 text-xs text-muted tabular-nums pt-0.5">{formatClock(startedAtMs + t.startMs)}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function SaveToKBPanel({
  sessionId, allowedRoleIds, allowedRoles,
}: { sessionId: string; allowedRoleIds: string[]; allowedRoles: { id: string; name: string; color: string | null }[] }) {
  const [savedArticleId, setSavedArticleId] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string>(allowedRoleIds[0] ?? "");
  const [submitting, setSubmitting] = useState(false);
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);

  if (savedArticleId) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        ✅ 已存为知识库文档（草稿状态）。
        <a href={`/d/${savedArticleId}`} className="ml-1 underline">在知识库中打开 →</a>
      </div>
    );
  }
  if (allowedRoleIds.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
        ⚠ 这场会议没有关联角色，无法保存到知识库。
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-white p-4 text-sm shadow-glass">
      <div className="mb-3 flex items-center gap-2 font-semibold text-fg">
        <span aria-hidden>📥</span>
        <span>保存到知识库</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">保存到角色：</span>
        <select
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-fg outline-none focus:border-primary"
        >
          {allowedRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={submitting || !roleId}
          onClick={async () => {
            setSubmitting(true);
            try {
              const r = await api.meeting.saveAsArticle(sessionId, { roleId });
              setSavedArticleId(r.article.id);
              // Nudge the left rail to refetch this role's subtree so the
              // freshly-saved draft appears without a manual page reload.
              requestRoleRefresh(roleId);
              toast.success("已存为知识库草稿");
            } catch (e) {
              toast.error(e instanceof ApiError ? e.message : (e as Error).message);
            } finally {
              setSubmitting(false);
            }
          }}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg shadow-glass transition enabled:hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "保存中…" : "保存为草稿"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        新文档以「{`会议主题 - 会议纪要`}」为标题，以草稿状态保存，你可以编辑后再发布。
      </p>
    </div>
  );
}

// Wall-clock hh:mm (24h, Beijing time) for an absolute epoch-ms instant.
// Transcript `startMs` offsets are added to the meeting start first.
function formatClock(epochMs: number): string {
  const { hour, minute } = beijingParts(new Date(epochMs));
  return `${hour}:${minute}`;
}
