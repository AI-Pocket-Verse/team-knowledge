import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { lineDiff, toBlocks, applySelection, countHunks } from "../../lib/lineDiff";
import { useT } from "../../i18n";

// 长未改动段折叠阈值:超过则只显示「⋯ N 行未改动 ⋯」,避免整篇 context 刷屏。
const CONTEXT_COLLAPSE = 6;

export function ReviewDiffDialog(props: {
  open: boolean;
  articleId: string;
  before: string;
  after: string;
  findingsCount?: number;
  /** 未能自动定位/应用的补丁数(部分成功);> 0 时提示用户仍有问题未修复。 */
  unlocated?: number;
  expectedUpdatedAt?: string;
  onCancel: () => void;
  onApplied: (newBody: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocks = useMemo(() => toBlocks(lineDiff(props.before, props.after)), [props.before, props.after]);
  const hunkCount = useMemo(() => countHunks(blocks), [blocks]);
  // 每个 hunk 一个勾选位,默认全选(全部采用优化)。
  const [selected, setSelected] = useState<boolean[]>(() => Array(hunkCount).fill(true));
  useEffect(() => { setSelected(Array(hunkCount).fill(true)); }, [hunkCount, props.before, props.after]);

  const result = useMemo(() => applySelection(blocks, selected), [blocks, selected]);
  const changedCount = selected.filter(Boolean).length;
  const noChange = result === props.before; // 一处都没选(或选的都无效)→ 等于原文

  if (!props.open) return null;

  function toggle(h: number) {
    setSelected((prev) => prev.map((v, i) => (i === h ? !v : v)));
  }
  function setAll(v: boolean) {
    setSelected(Array(hunkCount).fill(v));
  }

  async function onApply() {
    setBusy(true);
    setErr(null);
    try {
      await api.articles.review.apply(props.articleId, result, props.expectedUpdatedAt);
      props.onApplied(result);
    } catch (e) {
      setErr((e as Error).message || t("article.diff.failed"));
    } finally {
      setBusy(false);
    }
  }

  // 渲染:context 段(可折叠)+ 每个 hunk 一张带勾选的卡片(原行红删除线 / 新行绿)。
  let h = -1;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={props.onCancel}>
      <div className="flex w-full max-w-3xl flex-col rounded-xl bg-white p-5 shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-fg">{t("article.diff.title")}</h2>
          {hunkCount > 1 && (
            <div className="flex gap-2 text-xs">
              <button type="button" className="text-muted hover:text-primary" onClick={() => setAll(true)} disabled={busy}>{t("article.diff.selectAll")}</button>
              <button type="button" className="text-muted hover:text-primary" onClick={() => setAll(false)} disabled={busy}>{t("article.diff.selectNone")}</button>
            </div>
          )}
        </div>
        <p className="mb-3 text-xs text-muted">
          {props.findingsCount != null && t("article.diff.summary", { findings: props.findingsCount, hunks: hunkCount })}
          {t("article.diff.defaultAll", { n: changedCount })}
        </p>
        {props.unlocated != null && props.unlocated > 0 && (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {t("article.diff.unlocated", { n: props.unlocated })}
          </p>
        )}

        <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
          {blocks.map((b, bi) => {
            if (b.kind === "context") {
              const collapsed = b.lines.length > CONTEXT_COLLAPSE;
              return (
                <div key={bi} className="rounded-md bg-surface/60 px-3 py-1 font-mono text-[12px] text-muted">
                  {collapsed
                    ? t("article.diff.collapsed", { n: b.lines.length })
                    : (b.lines.join("\n") || " ")}
                </div>
              );
            }
            h += 1;
            const idx = h;
            const on = selected[idx] ?? true;
            return (
              <label
                key={bi}
                className={
                  "flex cursor-pointer gap-2 rounded-lg border p-2 " +
                  (on ? "border-primary/40 bg-white" : "border-line bg-surface/40 opacity-70")
                }
              >
                <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(idx)} className="mt-1 shrink-0" />
                <div className="min-w-0 flex-1 font-mono text-[13px] leading-relaxed">
                  {b.before.map((t, k) => (
                    <div key={`d${k}`} className="text-rose-700 line-through"><span className="select-none pr-2 text-muted">-</span>{t || " "}</div>
                  ))}
                  {b.after.map((t, k) => (
                    <div key={`a${k}`} className="text-emerald-800"><span className="select-none pr-2 text-muted">+</span>{t || " "}</div>
                  ))}
                </div>
              </label>
            );
          })}
        </div>

        {err && <p className="mt-2 text-sm text-rose-600">{err}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          {noChange && <span className="mr-auto text-xs text-muted">{t("article.diff.noneSelected")}</span>}
          <button className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface" onClick={props.onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-fg hover:opacity-90 disabled:opacity-50"
            onClick={onApply}
            disabled={busy || noChange}
          >
            {busy ? t("article.diff.applying") : t("article.diff.apply", { n: changedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}
