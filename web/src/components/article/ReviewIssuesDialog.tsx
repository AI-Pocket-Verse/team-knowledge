import { useState, useEffect } from "react";
import type { ReviewFinding } from "@team-knowledge/shared";
import { api } from "../../lib/api";
import { ReviewDiffDialog } from "./ReviewDiffDialog";
import { useT, type MessageKey } from "../../i18n";

const CATEGORY_LABEL: Record<string, MessageKey> = {
  logic: "article.review.cat.logic",
  clarity: "article.review.cat.clarity",
  format: "article.review.cat.format",
  completeness: "article.review.cat.completeness",
  consistency: "article.review.cat.consistency",
};
const SEVERITY_LABEL: Record<string, MessageKey> = { high: "article.review.sev.high", med: "article.review.sev.med", low: "article.review.sev.low" };

// 旋转 loading 图标(SVG + Tailwind animate-spin),默认随按钮文字大小。
function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

export function ReviewIssuesDialog(props: {
  open: boolean;
  articleId: string;
  findings: ReviewFinding[];
  currentMarkdown: string;
  expectedUpdatedAt?: string;
  onClose: () => void;
  /** 优化已应用(传入新正文)或已忽略 → 父组件刷新文章。 */
  onResolved: (next: { contentMarkdown?: string }) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<"optimize" | "dismiss" | null>(null);
  const [diff, setDiff] = useState<{ fixed: string; unlocated: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 优化流式进度:已生成字符数(SSE token 增量累计),用于「优化中…已生成 N 字」。
  const [optimizeChars, setOptimizeChars] = useState(0);
  // 已用时(秒):非流式 provider(如 codex)会憋到最后一次性吐全文,期间字数一直为 0,
  // 用实时用时让用户看到「在进行、没卡死」。
  const [optimizeSec, setOptimizeSec] = useState(0);

  useEffect(() => {
    if (busy !== "optimize") return;
    setOptimizeSec(0);
    const t = setInterval(() => setOptimizeSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  if (!props.open) return null;

  // 优化(调 LLM)进行中禁止关闭(× / 点弹窗外都不可),避免中途丢弃在途请求。
  const closable = busy === null;
  function tryClose() {
    if (closable) props.onClose();
  }

  async function onOptimize() {
    setBusy("optimize");
    setErr(null);
    setOptimizeChars(0);
    try {
      const r = await api.articles.review.optimize(props.articleId, {
        onProgress: (chars) => setOptimizeChars(chars),
      });
      setDiff({ fixed: r.fixedMarkdown, unlocated: r.unlocated });
    } catch (e) {
      setErr((e as Error).message || t("article.review.optimizeFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function onDismiss() {
    setBusy("dismiss");
    setErr(null);
    try {
      await api.articles.review.dismiss(props.articleId);
      props.onResolved({});
      props.onClose();
    } catch (e) {
      setErr((e as Error).message || t("article.review.actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={tryClose}>
        <div className="relative w-full max-w-lg rounded-xl bg-white p-5 shadow-pop" onClick={(e) => e.stopPropagation()}>
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-xs font-bold text-white">!</span>
            <h2 className="flex-1 text-base font-semibold text-fg">{t("article.review.title", { n: props.findings.length })}</h2>
            <button
              type="button"
              onClick={tryClose}
              disabled={!closable}
              aria-label={t("common.close")}
              title={t("article.review.closeTitle")}
              className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none text-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
            >
              ×
            </button>
          </div>
          <ul className="max-h-[50vh] space-y-2 overflow-auto">
            {props.findings.map((f, i) => (
              <li key={f.hash ?? i} className="rounded-lg border border-line p-3 text-sm">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded bg-surface px-1.5 py-0.5 text-xs text-muted">{CATEGORY_LABEL[f.category] ? t(CATEGORY_LABEL[f.category]) : f.category}</span>
                  <span className="text-xs text-muted">{t("article.review.severity", { level: SEVERITY_LABEL[f.severity] ? t(SEVERITY_LABEL[f.severity]) : f.severity })}</span>
                </div>
                <p className="text-fg">{f.problem}</p>
                {f.suggestion && <p className="mt-1 text-muted">{t("article.review.suggestion", { text: f.suggestion })}</p>}
              </li>
            ))}
          </ul>
          {err && <p className="mt-2 text-sm text-rose-600">{err}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface disabled:opacity-50" onClick={onDismiss} disabled={busy !== null}>
              {busy === "dismiss" ? t("article.review.processing") : t("article.review.dismiss")}
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg hover:opacity-90 disabled:opacity-60" onClick={onOptimize} disabled={busy !== null}>
              {busy === "optimize" && <Spinner />}
              {busy === "optimize" ? t("article.review.optimizing") : t("article.review.optimize")}
            </button>
          </div>

          {/* 优化进行中:盖一层带 loading 动画的遮罩,既给反馈又挡住交互。流式进度显示已生成字数。 */}
          {busy === "optimize" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-white/70 px-6 text-center backdrop-blur-[1px]">
              <Spinner className="h-7 w-7 text-primary" />
              <span className="text-sm text-muted">
                {optimizeChars > 0
                  ? t("article.review.progressChars", { n: optimizeChars })
                  : t("article.review.progressSec", { n: optimizeSec })}
              </span>
              {optimizeChars === 0 && optimizeSec >= 30 && (
                <span className="text-xs text-muted/70">{t("article.review.generatingPatches")}</span>
              )}
            </div>
          )}
        </div>
      </div>
      {diff && (
        <ReviewDiffDialog
          open
          articleId={props.articleId}
          before={props.currentMarkdown}
          after={diff.fixed}
          findingsCount={props.findings.length}
          unlocated={diff.unlocated}
          expectedUpdatedAt={props.expectedUpdatedAt}
          onCancel={() => setDiff(null)}
          onApplied={(newBody) => {
            setDiff(null);
            props.onResolved({ contentMarkdown: newBody });
            props.onClose();
          }}
        />
      )}
    </>
  );
}
