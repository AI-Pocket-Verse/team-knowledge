import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface SelectOption { value: string; label: string }

// 轻量自定义下拉:替代原生 <select>(原生弹层无法美化)。菜单 portal 到 body,避免被弹窗滚动容器裁剪;
// 菜单节点带 data-automation-menu,供外层 Dialog 的 onPointerDownOutside 豁免(点菜单不关弹窗)。
export function Select({ value, onChange, options, className }: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const openUp = below < 200 && above > below; // 下方空间不足则向上弹
    setPos({
      left: r.left, width: r.width,
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxHeight: Math.min(240, (openUp ? above : below) - 12),
    });
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

  const current = options.find((o) => o.value === value);
  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)}
        className={cn("flex h-10 items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 text-sm text-fg transition hover:border-primary/50 focus:border-primary focus:outline-none", className)}>
        <span className="truncate">{current?.label ?? value}</span>
        <svg className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} data-automation-menu
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.maxHeight, zIndex: 70, pointerEvents: "auto" }}
          className="overflow-auto rounded-lg border border-line bg-white p-1 shadow-glassLg">
          {options.map((o) => (
            <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition",
                o.value === value ? "bg-accent-soft font-medium text-primary" : "text-fg hover:bg-surface")}>
              <span className={cn("w-3 shrink-0 text-primary", o.value === value ? "opacity-100" : "opacity-0")}>✓</span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS: SelectOption[] = Array.from({ length: 24 }, (_, i) => ({ value: pad(i), label: pad(i) }));
const MINUTES: SelectOption[] = Array.from({ length: 60 }, (_, i) => ({ value: pad(i), label: pad(i) }));

// 时:分选择器(两个自定义下拉),value/onChange 用 "HH:MM" 字符串。
export function TimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [h, m] = (value || "09:00").split(":");
  return (
    <div className="flex items-center gap-1.5">
      <Select className="w-[72px]" value={h ?? "09"} options={HOURS} onChange={(nh) => onChange(`${nh}:${m ?? "00"}`)} />
      <span className="text-muted">:</span>
      <Select className="w-[72px]" value={m ?? "00"} options={MINUTES} onChange={(nm) => onChange(`${h ?? "09"}:${nm}`)} />
    </div>
  );
}
