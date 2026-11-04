import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

interface Props {
  /** Wait this long before rendering anything. Below 1s users perceive
   *  the page as instant — flashing a "加载中…" string then immediately
   *  swapping it for the real content feels janky. Above ~1s users
   *  start to wonder if the click registered, so we surface a spinner
   *  to confirm something IS happening. */
  delay?: number;
  /** Style preset. `page` centers in the viewport for full-page loads,
   *  `inline` keeps the spinner flow-relative for embedded sections
   *  (comment list, version drawer). */
  variant?: "page" | "inline";
  className?: string;
  /** Optional caption under the spinner (e.g. "正在加载 文档编辑器…") so a slow
   *  chunk download tells the user WHAT is loading, not just that something is. */
  label?: string;
}

/**
 * Loading affordance that stays invisible for the first `delay` ms
 * and then shows a centered spinner. Replaces the plain "加载中…"
 * text label across pages — it was always-visible from t=0ms and
 * appeared on every navigation, including instant ones, which made
 * the UI feel slower than it actually is.
 */
export function DelayedLoader({ delay = 1000, variant = "page", className, label }: Props) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), delay);
    return () => window.clearTimeout(t);
  }, [delay]);
  if (!show) return null;
  return (
    <div
      className={cn(
        variant === "page"
          ? "flex min-h-[50vh] items-center justify-center"
          : "flex items-center justify-center py-6",
        className,
      )}
      role="status"
      aria-label={label ?? "加载中"}
    >
      <div className="flex flex-col items-center gap-3">
        <svg
          className="h-7 w-7 animate-spin text-primary"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <path
            d="M22 12a10 10 0 0 1-10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        {label && <div className="text-sm text-muted">{label}</div>}
      </div>
    </div>
  );
}
