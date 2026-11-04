import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ReviewFinding } from "@team-knowledge/shared";
import type { ReviewIssueRow, ReviewDismissedRow } from "@/lib/api";
import { api } from "@/lib/api";
import { useIsAdmin } from "@/stores/auth";
import { toast } from "@/components/Toaster";
import { ReviewIssuesDialog } from "@/components/article/ReviewIssuesDialog";
import { ArticleReviewToggle } from "./adminSettingsSections";
import { useT, type MessageKey } from "@/i18n";

const CATEGORY_LABEL: Record<string, MessageKey> = {
  logic: "admin.review.cat.logic",
  clarity: "admin.review.cat.clarity",
  format: "admin.review.cat.format",
  completeness: "admin.review.cat.completeness",
  consistency: "admin.review.cat.consistency",
};
const SEVERITY_LABEL: Record<string, MessageKey> = { high: "admin.review.sev.high", med: "admin.review.sev.med", low: "admin.review.sev.low" };

// 访问门控由路由层 RequireAdminPage(pageKey="article-review")负责:管理员,或该页已在
// 「页面可见性」放开给所有成员。这里不再自拦 isAdmin —— 否则放开后成员会被弹走(与「所有
// 成员可见」矛盾)。页内的「检测配置」是全局设置,仅管理员可见/可改(见 Inner + 后端守卫)。
export function AdminArticleReviewPage() {
  return <Inner />;
}

interface OptimizeTarget {
  id: string;
  findings: ReviewFinding[];
  currentMarkdown: string;
  expectedUpdatedAt: string;
}

function Inner() {
  const t = useT();
  const catLabel = (c: string) => (CATEGORY_LABEL[c] ? t(CATEGORY_LABEL[c]) : c);
  const sevLabel = (s: string) => (SEVERITY_LABEL[s] ? t(SEVERITY_LABEL[s]) : s);
  // 「检测配置」是全局设置(开关/间隔/严重度/提醒),仅管理员可见可改;放开给成员时成员
  // 只看「待优化/已忽略」。默认停在 issues,故非管理员进来不会落到隐藏的 config tab。
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<"config" | "issues" | "dismissed">("issues");
  const [issues, setIssues] = useState<ReviewIssueRow[] | null>(null);
  const [dismissed, setDismissed] = useState<ReviewDismissedRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [optimizeTarget, setOptimizeTarget] = useState<OptimizeTarget | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.adminArticleReview.issues(), api.adminArticleReview.dismissed()]);
      setIssues(a.items);
      setDismissed(b.items);
    } catch (e) {
      toast.error((e as Error).message || t("error.loadFailed"));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function onOptimize(id: string) {
    setBusyId(id);
    try {
      const r = await api.articles.get(id);
      const findings = (r.article.reviewFindings ?? []) as ReviewFinding[];
      if (findings.length === 0) { toast.success(t("admin.review.noneLeft")); await reload(); return; }
      setOptimizeTarget({ id, findings, currentMarkdown: r.article.contentMarkdown, expectedUpdatedAt: r.article.updatedAt });
    } catch (e) {
      toast.error((e as Error).message || t("admin.review.openFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function onDismissAll(id: string) {
    setBusyId(id);
    try {
      await api.articles.review.dismiss(id);
      toast.success(t("admin.review.dismissedAll"));
      await reload();
    } catch (e) {
      toast.error((e as Error).message || t("error.actionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function onUndismiss(row: ReviewDismissedRow) {
    setBusyId(row.articleId + row.hash);
    try {
      await api.adminArticleReview.undismiss(row.articleId, row.hash);
      toast.success(t("admin.review.undismissed"));
      await reload();
    } catch (e) {
      toast.error((e as Error).message || t("error.actionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-full">
      <p className="text-sm text-muted">
        {t("admin.review.desc")}
      </p>

      <div className="mb-6 mt-4 flex gap-1 border-b border-line">
        {([
          // 检测配置 tab 仅管理员可见(全局设置,不让普通成员改)。
          ...(isAdmin ? [{ key: "config" as const, label: t("admin.review.tabConfig") }] : []),
          { key: "issues" as const, label: `${t("admin.review.tabIssues")}${issues ? `(${issues.length})` : ""}` },
          { key: "dismissed" as const, label: `${t("admin.review.tabDismissed")}${dismissed ? `(${dismissed.length})` : ""}` },
        ]).map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setTab(tb.key)}
            className={
              "-mb-px px-3 py-2 text-sm transition " +
              (tab === tb.key ? "border-b-2 border-primary font-medium text-primary" : "text-muted hover:text-fg")
            }
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "config" && isAdmin && <ArticleReviewToggle />}

      {tab === "issues" && (
        <div className="flex flex-col gap-3">
          {issues === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
          {issues?.length === 0 && <p className="text-sm text-muted">{t("admin.review.emptyIssues")}</p>}
          {issues?.map((row) => (
            <div key={row.id} className="rounded-xl border border-line bg-white p-4 shadow-glass">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link to={`/d/${row.id}`} className="text-sm font-medium text-primary hover:underline">{row.title || t("admin.review.untitled")}</Link>
                  <div className="mt-0.5 text-xs text-muted">{row.roleName ?? "—"} · {t("admin.review.problemCount", { n: row.findings.length })}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" disabled={busyId === row.id} onClick={() => void onDismissAll(row.id)} className="rounded-lg px-2.5 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50">{t("admin.review.dismiss")}</button>
                  <button type="button" disabled={busyId === row.id} onClick={() => void onOptimize(row.id)} className="rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-fg hover:opacity-90 disabled:opacity-50">{busyId === row.id ? "…" : t("admin.review.optimize")}</button>
                </div>
              </div>
              <ul className="space-y-1.5">
                {row.findings.map((f, i) => (
                  <li key={f.hash ?? i} className="text-xs text-fg">
                    <span className="mr-1 rounded bg-surface px-1.5 py-0.5 text-muted">{catLabel(f.category)}</span>
                    <span className="mr-1 text-muted">[{sevLabel(f.severity)}]</span>
                    {f.problem}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === "dismissed" && (
        <div className="flex flex-col gap-2">
          {dismissed === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
          {dismissed?.length === 0 && <p className="text-sm text-muted">{t("admin.review.emptyDismissed")}</p>}
          {dismissed?.map((row) => (
            <div key={row.articleId + row.hash} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-white p-3 shadow-glass">
              <div className="min-w-0 text-xs">
                <Link to={`/d/${row.articleId}`} className="font-medium text-primary hover:underline">{row.articleTitle}</Link>
                <div className="mt-0.5 text-fg">
                  <span className="mr-1 rounded bg-surface px-1.5 py-0.5 text-muted">{catLabel(row.category)}</span>
                  {row.problem}
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === row.articleId + row.hash}
                onClick={() => void onUndismiss(row)}
                className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs text-fg hover:bg-surface disabled:opacity-50"
              >
                {t("admin.review.undismiss")}
              </button>
            </div>
          ))}
        </div>
      )}

      {optimizeTarget && (
        <ReviewIssuesDialog
          open
          articleId={optimizeTarget.id}
          findings={optimizeTarget.findings}
          currentMarkdown={optimizeTarget.currentMarkdown}
          expectedUpdatedAt={optimizeTarget.expectedUpdatedAt}
          onClose={() => setOptimizeTarget(null)}
          onResolved={() => { setOptimizeTarget(null); void reload(); }}
        />
      )}
    </div>
  );
}
