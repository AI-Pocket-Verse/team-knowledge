import type { ReactNode } from "react";

// One-shot entrance wrapper for dashboard sections. Applies the `.tm-reveal`
// fade-up animation (index.css) with a per-section stagger via animation-delay.
// Plays once when the section first mounts; SSE-driven re-renders update the
// children in place (no remount) so it doesn't replay on every refetch.
// Reduced-motion users get no animation (handled in CSS).
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <div className="tm-reveal" style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}
