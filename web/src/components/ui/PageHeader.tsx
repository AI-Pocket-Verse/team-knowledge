import { cn } from "@/lib/cn";

// Two-line page header used by every landing surface (workspace home,
// role page, folder list, profile, etc.). Mirrors the title+subtitle
// pattern in sub.png: bold title with a small muted description on
// the second line, optional left-side adornment (role color chip etc.)
// and an optional right slot for the page's primary CTA.
//
// Kept dumb on purpose — no data fetching, no router awareness, just
// layout. Each page assembles its own content and hands it in.
export function PageHeader({
  title,
  subtitle,
  leftSlot,
  rightSlot,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      {leftSlot && <div className="shrink-0 mt-1">{leftSlot}</div>}
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold text-fg leading-tight truncate">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-xs text-muted leading-relaxed">{subtitle}</p>
        )}
      </div>
      {rightSlot && <div className="shrink-0">{rightSlot}</div>}
    </div>
  );
}
