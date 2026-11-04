import { cn } from "@/lib/cn";

// Shared collapse/expand chevron — the SAME glyph the workspace left
// rail uses for role / folder rows (a right-pointing chevron that
// rotates 90° to point down when open). Adopting it everywhere replaces
// the tiny ▾ triangles that used to mark vertical collapse toggles, so
// every expand/collapse affordance in the app reads identically.
export function CollapseChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("transition-transform", open && "rotate-90", className)}
      aria-hidden
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
