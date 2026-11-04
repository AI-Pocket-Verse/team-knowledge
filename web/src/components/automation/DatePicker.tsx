import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useI18n } from "@/i18n";

// 自定义日期选择器(替代原生 <input type=date> 的原生日历弹层,无法美化)。
// value/onChange 用 "YYYY-MM-DD"(北京墙钟日期,与表单其余逻辑一致);纯日历算术,不涉时区换算。
// 菜单 portal 到 body(带 data-automation-menu),避免被弹窗滚动容器裁剪、且不触发 Dialog 外点关闭。
const pad = (n: number) => String(n).padStart(2, "0");
const WEEK = [7, 1, 2, 3, 4, 5, 6] as const; // 周日在前
type YMD = { y: number; m: number; d: number };

function beijingToday(): YMD {
  const b = new Date(Date.now() + 8 * 3600_000);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
}
function parseYMD(s: string): YMD | null {
  const [y, m, d] = s.split("-").map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? { y, m, d } : null;
}

export function DatePicker({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const today = beijingToday();
  const sel = value ? parseYMD(value) : null;
  const [view, setView] = useState<{ y: number; m: number }>(() => (sel ? { y: sel.y, m: sel.m } : { y: today.y, m: today.m }));

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const MENU_H = 360;
    const openUp = window.innerHeight - r.bottom < MENU_H && r.top > window.innerHeight - r.bottom;
    setPos({ left: r.left, ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
    setView(sel ? { y: sel.y, m: sel.m } : { y: today.y, m: today.m }); // 每次打开回到选中/当月
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  // 6×7 网格(含相邻月补位,置灰)。用 Date.UTC 做纯日历算术。
  const firstDow = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const prev = view.m === 1 ? { y: view.y - 1, m: 12 } : { y: view.y, m: view.m - 1 };
  const prevDays = new Date(Date.UTC(prev.y, prev.m, 0)).getUTCDate();
  const next = view.m === 12 ? { y: view.y + 1, m: 1 } : { y: view.y, m: view.m + 1 };
  const cells: (YMD & { cur: boolean })[] = [];
  for (let i = firstDow - 1; i >= 0; i--) cells.push({ ...prev, d: prevDays - i, cur: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ y: view.y, m: view.m, d, cur: true });
  for (let d = 1; cells.length < 42; d++) cells.push({ ...next, d, cur: false });

  const shiftMonth = (delta: number) => setView((v) => {
    const idx = v.y * 12 + (v.m - 1) + delta;
    return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
  });
  const pick = (c: YMD) => { onChange(`${c.y}-${pad(c.m)}-${pad(c.d)}`); setOpen(false); };
  const same = (a: YMD, b: YMD | null) => !!b && a.y === b.y && a.m === b.m && a.d === b.d;

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)}
        className={cn("flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm transition hover:border-primary/50 focus:border-primary focus:outline-none", value ? "text-fg" : "text-muted", className)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M8 2v4M16 2v4M3 10h18" /></svg>
        <span className="truncate">{value || placeholder || t("automation.pickDate")}</span>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} data-automation-menu style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, zIndex: 70, pointerEvents: "auto" }}
          className="w-[288px] rounded-xl border border-line bg-white p-3 shadow-glassLg">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-fg">{t("automation.monthTitle", { y: view.y, m: view.m, monthName: new Date(Date.UTC(view.y, view.m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }) })}</div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => shiftMonth(-1)} aria-label={t("automation.prevMonth")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-surface hover:text-fg">‹</button>
              <button type="button" onClick={() => shiftMonth(1)} aria-label={t("automation.nextMonth")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-surface hover:text-fg">›</button>
            </div>
          </div>
          <div className="mb-1 grid grid-cols-7 text-center text-xs text-muted">
            {WEEK.map((w) => <div key={w} className="py-1">{t(`automation.wd.${w}`)}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((c, i) => (
              <button key={i} type="button" onClick={() => pick(c)}
                className={cn("flex h-8 items-center justify-center rounded-md text-sm transition",
                  same(c, sel) ? "bg-primary font-semibold text-primary-fg"
                    : !c.cur ? "text-muted/40 hover:bg-surface"
                    : same(c, today) ? "font-semibold text-primary hover:bg-surface"
                    : "text-fg hover:bg-surface")}>
                {c.d}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-sm">
            <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-muted transition hover:text-fg">{t("automation.clear")}</button>
            <button type="button" onClick={() => pick(today)} className="font-medium text-primary transition hover:opacity-80">{t("automation.today")}</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
