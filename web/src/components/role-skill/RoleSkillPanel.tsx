import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Copy, Download, RefreshCw, X, Check } from "lucide-react";
import { api, type RoleSkillData, type RoleSkillStatus } from "@/lib/api";
import { fmtDateTime } from "@/lib/relativeTime";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { toast } from "@/components/Toaster";

// Read-only viewer for a role's AI-generated skill.md. The file is never edited
// here — only copied / downloaded / regenerated. Generation happens server-side
// (debounced); this polls while a generation is in flight.

const BADGE: Record<RoleSkillStatus, { label: string; cls: string }> = {
  fresh: { label: "已是最新", cls: "bg-emerald-50 text-emerald-700" },
  generating: { label: "生成中…", cls: "bg-blue-50 text-primary" },
  stale: { label: "已过期,改动停止约 5 分钟后自动更新", cls: "bg-amber-50 text-amber-700" },
  failed: { label: "生成失败,可重试", cls: "bg-rose-50 text-rose-600" },
  empty: { label: "尚未生成", cls: "bg-slate-100 text-muted" },
};

// yyyy-MM-dd HH:mm — Skill 生成是个有时效语义的动作,精确到分钟比只给日期有用。
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try { return fmtDateTime(iso); } catch { return ""; }
}

// Strip the leading YAML frontmatter for the rendered preview (it's metadata,
// not body content). Copy/download still use the full raw markdown.
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  return m ? md.slice(m[0].length) : md;
}

// Max wall-clock to keep polling after a regenerate / while generating, so the
// 3s loop can't run forever if generation never starts (provider busy/down, or
// the dispatcher isn't running).
const POLL_WINDOW_MS = 120_000;

export function RoleSkillPanel({ roleId }: { roleId: string }) {
  const [data, setData] = useState<RoleSkillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [polling, setPolling] = useState(false);
  const [view, setView] = useState<"preview" | "markdown">("preview");
  const pollDeadline = useRef(0);

  const load = useCallback(async () => {
    try {
      const d = await api.roleSkill.get(roleId);
      setData(d);
      return d;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [roleId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  // Drive polling from the fetched status: keep polling while generating
  // (extending the window); stop on a terminal/empty state. A passively-stale
  // skill (not regenerating) does NOT poll — only an in-flight generation or a
  // user-triggered regenerate (which sets the deadline) does.
  useEffect(() => {
    const s = data?.status;
    if (s === "generating") {
      pollDeadline.current = Math.max(pollDeadline.current, Date.now() + POLL_WINDOW_MS);
      setPolling(true);
    } else if (s === "fresh" || s === "failed" || s === "empty") {
      setPolling(false);
    }
  }, [data?.status]);

  // 3s poll, hard-bounded by the deadline so it can never spin indefinitely.
  useEffect(() => {
    if (!polling) return;
    const t = window.setInterval(() => {
      if (Date.now() > pollDeadline.current) { setPolling(false); return; }
      void load();
    }, 3000);
    return () => window.clearInterval(t);
  }, [polling, load]);

  async function onRegenerate() {
    setBusy(true);
    try {
      const r = await api.roleSkill.regenerate(roleId);
      if (r.upToDate) {
        // Docs unchanged + already fresh → nothing to do; keep the existing latest.
        toast.success("已是最新,无需重新生成");
        await load();
      } else {
        pollDeadline.current = Date.now() + POLL_WINDOW_MS;
        setPolling(true);
        await load();
      }
    } catch { /* surfaced via status on next load */ }
    finally { setBusy(false); }
  }

  async function onCopy() {
    if (!data?.content) return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can still download */ }
  }

  const status = data?.status ?? "empty";
  const badge = BADGE[status];
  const hasContent = !!data?.content;
  // No published docs (only folders / drafts / empty) → nothing to distil, so the
  // skill can't be (re)generated; greys out the actions and shows a hint instead.
  const noDocs = (data?.currentDocCount ?? 0) === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-1 pb-3">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${badge.cls}`}>
          {status === "generating" && <RefreshCw className="mr-1 h-3 w-3 animate-spin" />}
          {badge.label}
        </span>
        {hasContent && !noDocs && (
          <div className="inline-flex rounded-md border border-line p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setView("preview")}
              className={view === "preview" ? "rounded bg-primary px-2 py-0.5 font-medium text-primary-fg" : "rounded px-2 py-0.5 text-muted hover:text-fg"}
            >
              预览
            </button>
            <button
              type="button"
              onClick={() => setView("markdown")}
              className={view === "markdown" ? "rounded bg-primary px-2 py-0.5 font-medium text-primary-fg" : "rounded px-2 py-0.5 text-muted hover:text-fg"}
            >
              Markdown
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCopy}
            disabled={!hasContent || noDocs}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-fg/85 transition hover:bg-blue-50 hover:text-primary disabled:opacity-40"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
          <a
            href={hasContent && !noDocs ? api.roleSkill.rawUrl(roleId, { download: true }) : undefined}
            aria-disabled={!hasContent || noDocs}
            className={`inline-flex items-center gap-1 rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-fg/85 transition hover:bg-blue-50 hover:text-primary ${hasContent && !noDocs ? "" : "pointer-events-none opacity-40"}`}
          >
            <Download className="h-3.5 w-3.5" /> 下载
          </a>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy || status === "generating" || noDocs}
            title={noDocs ? "该角色暂无已发布文档,无法生成" : undefined}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-fg transition hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> 重新生成
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto py-3">
        {loading ? (
          <div className="px-1 py-10 text-center text-sm text-muted">加载中…</div>
        ) : noDocs ? (
          <div className="px-1 py-12 text-center text-sm text-muted">
            该角色暂无已发布文档,无法生成 skill。
            <br />
            <span className="text-xs text-muted/80">新建并发布文档后会自动生成。</span>
          </div>
        ) : status === "failed" && !hasContent ? (
          <div className="px-1 py-10 text-center text-sm text-rose-600">
            生成失败{data?.error ? `:${data.error}` : ""}。点「重新生成」重试。
          </div>
        ) : status === "empty" || !hasContent ? (
          <div className="px-1 py-10 text-center text-sm text-muted">
            该角色还没有 skill。发布文档后会自动生成,或点「重新生成」。
          </div>
        ) : view === "preview" ? (
          <div className="px-1 text-sm leading-relaxed text-fg/90">
            <ChatMarkdown text={stripFrontmatter(data!.content)} refs={[]} />
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-fg/90">
            {data!.content}
          </pre>
        )}
      </div>

      {/* Footer */}
      {hasContent && !noDocs && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 border-t border-line px-1 pt-2 text-[11px] text-muted">
          {data!.generatedAt && <span>生成于 {fmtTime(data!.generatedAt)}</span>}
          <span>收录 {data!.docCount} 篇已发布文档</span>
          {data!.truncated > 0 && <span>{data!.truncated} 篇因篇幅截断(仅标题+开头)</span>}
        </div>
      )}
    </div>
  );
}

/** Workspace entry: a "Skill" button that opens the panel in a modal. */
export function RoleSkillDialogButton({
  roleId,
  roleName,
  className,
}: {
  roleId: string;
  roleName: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RoleSkillStatus | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Lightweight status poll so the button can show a "generating" indicator
  // without opening the panel. Re-fetches immediately when the modal opens/closes
  // (a regenerate may have just started) and every 10s otherwise.
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = () => {
      api.roleSkill.get(roleId).then((d) => { if (!cancelled) setStatus(d.status); }).catch(() => {});
    };
    fetchStatus();
    const t = window.setInterval(fetchStatus, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [roleId, open]);

  useEffect(() => {
    if (!open) return;
    // Lock background scroll + move focus into the dialog while open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      <span className="relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="角色技能 skill.md"
          className={
            className ??
            "inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-fg/85 transition hover:bg-blue-50 hover:text-primary"
          }
        >
          <Sparkles className="h-4 w-4" /> Skill
        </button>
        {status === "generating" && (
          <span
            className="pointer-events-none absolute -right-1 -top-1 flex h-2.5 w-2.5"
            title="技能生成中…"
            aria-label="技能生成中"
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
          </span>
        )}
        {/* stale = 改动后的防抖等待期(QUIET_MS 5 分钟静默 + 每分钟扫描),
            真正开始生成后切换为上面的红色脉冲点。琥珀静点与面板里
            「已过期」徽标同色系。 */}
        {status === "stale" && (
          <span
            className="pointer-events-none absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-amber-400"
            title="已过期,改动停止约 5 分钟后自动更新"
            aria-label="技能待自动更新"
          />
        )}
      </span>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[1px]"
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="flex h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-white p-5 shadow-xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-base font-semibold text-fg">
                  <Sparkles className="h-4 w-4 text-primary" /> 角色技能
                </div>
                <div className="truncate text-xs text-muted">《{roleName}》 skill.md(只读,可复制/下载)</div>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <RoleSkillPanel roleId={roleId} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
