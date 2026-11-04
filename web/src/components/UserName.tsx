import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

/**
 * Inline display of a user's name. When `userId` is present it links to that
 * user's public profile (`/u/:userId`); otherwise it renders a plain span (the
 * user was hard-deleted, or only a name string is available). Inline-friendly —
 * no avatar — so it drops into bylines, comment headers, and feed rows in place
 * of the bare `{name}` text.
 */
export function UserName({
  userId,
  name,
  className,
}: {
  userId?: string | null;
  name: string;
  className?: string;
}) {
  if (userId) {
    return (
      <Link
        to={`/u/${userId}`}
        className={cn("hover:underline hover:text-primary transition", className)}
      >
        {name}
      </Link>
    );
  }
  return <span className={className}>{name}</span>;
}
