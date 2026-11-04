import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Search, Clock, X } from "lucide-react";
import type { ArticleSearchHit, RecentViewHit } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { DocResultRow } from "@/components/shell/search/DocResultRow";
import {
  readSearchHistory,
  addSearchHistory,
  removeSearchHistory,
  clearSearchHistory,
} from "@/lib/searchHistory";
import { useT } from "@/i18n";

/**
 * 顶栏「搜索文档」:右上角搜索 icon(通知铃铛左边),点击弹出**居中弹窗**(命令面板式,
 * 背景压暗、portal 挂 document.body 绕开 header 的 transform/backdrop 包含块)。
 *
 * 参考飞书文档搜索弹窗:
 *  - 顶部扁平搜索输入(放大镜在左,下方分隔线);
 *  - **空查询**展示「搜索历史」(本机 localStorage,可单条删除/清空)+「最近浏览」
 *    (复用后端 ArticleView);
 *  - **有查询**展示富信息结果列表。
 * 输入防抖 250ms;单调 reqId 丢弃过期响应;Esc/点暗背景/选中结果关闭。打开时自动聚焦。
 */
export function HeaderSearch() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArticleSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<RecentViewHit[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  // 当前键盘高亮的结果下标(仅有查询时的结果列表生效)。
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const navigate = useNavigate();

  // 打开时:聚焦输入、读本机历史、拉一次最近浏览(失败静默隐藏该段)。
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    setHistory(readSearchHistory());
    let alive = true;
    api.articles
      .recentViews(8)
      .then((res) => { if (alive) setRecent(res.hits); })
      .catch(() => { if (alive) setRecent([]); });
    return () => { alive = false; };
  }, [open]);

  // 防抖搜索 + 丢弃过期响应。清空输入即收起结果(回到历史/最近浏览空态)。
  useEffect(() => {
    const term = q.trim();
    if (term.length === 0) {
      reqIdRef.current++; // 作废在途响应:清空输入后,迟到的搜索结果不再回填 hits
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = window.setTimeout(async () => {
      const myId = ++reqIdRef.current;
      try {
        const res = await api.articles.search(term);
        if (myId !== reqIdRef.current) return;
        setHits(res.hits);
      } catch {
        if (myId !== reqIdRef.current) return;
        setHits([]);
      } finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  // 结果变化时高亮回到第一条(键盘上下选择 / 回车跳转的基准)。
  useEffect(() => { setActive(0); }, [hits]);

  // Esc 关闭(点暗色背景的关闭走 backdrop 的 onClick)。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => { setOpen(false); setQ(""); };
  // 点搜索结果:把当前搜索词写入历史后跳转关闭。点最近浏览行:仅关闭(无查询词可记)。
  const onPickResult = () => { setHistory(addSearchHistory(q.trim())); close(); };
  // 键盘回车跳转选中的结果:写历史 + 关闭 + 编程式导航(鼠标点击走 Link 自身导航)。
  const goTo = (id: string) => { setHistory(addSearchHistory(q.trim())); close(); navigate(`/d/${id}`); };
  const onPickHistory = (term: string) => { setQ(term); inputRef.current?.focus(); };

  const showEmptyState = q.trim().length === 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("shell.search.title")}
        title={t("shell.search.title")}
        className={`flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-blue-50 hover:text-primary ${open ? "bg-blue-50 text-primary" : ""}`}
      >
        <Search className="h-[18px] w-[18px]" />
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={t("shell.search.title")}>
            {/* 压暗背景 —— 点击关闭 */}
            <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} aria-hidden />
            {/* 水平居中、垂直约 1/4 处再上移 80px 的搜索面板 */}
            <div className="absolute left-1/2 top-1/4 flex max-h-[70vh] w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-[80px] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-pop">
              {/* 顶部:扁平搜索输入 + 下分隔线 */}
              <div className="relative border-b border-line">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted" aria-hidden />
                <input
                  ref={inputRef}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (showEmptyState || hits.length === 0) return;
                    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                    else if (e.key === "Enter") { e.preventDefault(); const h = hits[active]; if (h) goTo(h.id); }
                  }}
                  placeholder={t("shell.search.placeholder")}
                  className="w-full bg-transparent py-3.5 pl-12 pr-4 text-[15px] placeholder:text-muted focus:outline-none"
                  role="combobox"
                  aria-expanded={!showEmptyState && hits.length > 0}
                  aria-controls="header-search-results"
                  aria-activedescendant={!showEmptyState && hits.length > 0 ? `hs-opt-${active}` : undefined}
                />
              </div>

              {/* 主体:空态显示历史 + 最近浏览;有查询显示结果 */}
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {showEmptyState ? (
                  <>
                    {history.length > 0 && (
                      <section className="mb-1">
                        <div className="flex items-center justify-between px-3 pb-1 pt-2">
                          <span className="text-xs font-medium text-muted">{t("shell.search.history")}</span>
                          <button
                            type="button"
                            onClick={() => setHistory(clearSearchHistory())}
                            className="text-xs text-muted transition hover:text-primary"
                          >
                            {t("shell.search.clear")}
                          </button>
                        </div>
                        <ul>
                          {history.map((term) => (
                            <li key={term} className="group flex items-center rounded-lg pr-1 hover:bg-blue-50/60">
                              <button
                                type="button"
                                onClick={() => onPickHistory(term)}
                                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm text-fg"
                              >
                                <Clock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                                <span className="truncate">{term}</span>
                              </button>
                              <button
                                type="button"
                                aria-label={t("shell.search.removeHistory", { term })}
                                onClick={() => setHistory(removeSearchHistory(term))}
                                className="shrink-0 rounded p-1 text-muted opacity-0 transition hover:bg-slate-200/70 hover:text-fg group-hover:opacity-100"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {recent.length > 0 && (
                      <section>
                        <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted">{t("shell.search.recent")}</div>
                        {recent.map((d) => (
                          <DocResultRow key={d.id} doc={d} onNavigate={close} />
                        ))}
                      </section>
                    )}

                    {history.length === 0 && recent.length === 0 && (
                      <div className="px-3 py-6 text-center text-sm text-muted">{t("shell.search.hint")}</div>
                    )}
                  </>
                ) : (
                  <div id="header-search-results" role="listbox" aria-label={t("shell.search.results")}>
                    {loading && hits.length === 0 && <div className="px-3 py-2 text-sm text-muted">{t("shell.search.searching")}</div>}
                    {!loading && hits.length === 0 && <div className="px-3 py-2 text-sm text-muted">{t("shell.search.noMatch")}</div>}
                    {hits.map((h, i) => (
                      <DocResultRow
                        key={h.id}
                        doc={h}
                        optionId={`hs-opt-${i}`}
                        active={i === active}
                        onMouseEnter={() => setActive(i)}
                        onNavigate={onPickResult}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
