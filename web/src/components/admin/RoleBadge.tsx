import { resolveRoleColor } from "@/lib/roleColors";

export function RoleBadge({
  name,
  color,
  collapsed,
  variant = "solid",
}: {
  name: string;
  color: string | null;
  collapsed?: boolean;
  /// "solid" = legacy gradient chip with white text. Used by admin
  /// surfaces / detail headers where the badge is the focal point.
  /// "soft"  = pale tinted pill with same-hue dark text. Used by
  /// list/table rows where a strong gradient would compete with
  /// titles and status chips for visual weight.
  variant?: "solid" | "soft";
}) {
  const { from, to } = resolveRoleColor(color);
  if (collapsed) {
    // Square chip with the first character; used by the collapsed
    // sidebar where there's no room for the role name. Width matches
    // the toggle button so the column lines up cleanly.
    const initial = name.trim().slice(0, 1) || "·";
    return (
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold text-white shadow-sm"
        style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
        aria-label={name}
      >
        {initial}
      </span>
    );
  }

  if (variant === "soft") {
    // Same hue, pale tinted pill. The gradient `from` color drives
    // both background (~12% alpha) and the text (full saturation).
    // Two-stop palette keeps drift between badge variants visually
    // consistent across the whole app.
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap"
        style={{ background: `${from}1f`, color: from }}
      >
        {name}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-white shadow-sm"
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {name}
    </span>
  );
}
