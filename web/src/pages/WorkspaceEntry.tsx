import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { WorkspaceRole } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { useAuth, useIsAdmin } from "@/stores/auth";
import { DelayedLoader } from "@/components/DelayedLoader";
import { HomeChatRoute } from "@/components/chat/HomeChatRoute";
import { useT } from "@/i18n";

// Landing surface at `/`. Two columns:
//   - left: empty / welcome (catalog is browsed from the left rail)
//   - right: AI chat panel (HomeChatPanel) — messages above, composer
//     below. Shares state with the floating AiBubble via useChatStore,
//     so the user can continue the same conversation from either UI.
export function WorkspaceEntry() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const isAdmin = useIsAdmin();
  const [roles, setRoles] = useState<WorkspaceRole[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { roles: rs } = await api.workspace.listRoles();
        if (!cancelled) setRoles(rs);
      } catch {
        if (!cancelled) setRoles([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (roles === null) {
    return <DelayedLoader />;
  }

  // `absolute inset-5` positions the row 20px from each of main's
  // border edges, bypassing main's px-8 py-8 (32px) padding for the
  // home route only. main is `position: relative` (see WorkspaceShell),
  // and absolute children measure their offsets from the parent's
  // padding box — for main (no border), that equals the border box.
  // Other routes (article / bookmarks / role) keep main's 32px
  // breathing room because they render via normal flow, not absolute.
  //
  // Layout:
  //   - When the caller has zero accessible roles, surface the empty-
  //     state card as a 400px-wide column on the left so the chat
  //     still has the right side to itself.
  //   - Otherwise the chat takes the entire main area — no empty
  //     left column to stare at.
  const showEmpty = roles.length === 0;
  return (
    <div className="absolute inset-5 flex gap-6">
      {showEmpty && (
        <div className="w-[400px] shrink-0">
          <div className="rounded-xl border border-line bg-white p-8 text-center shadow-glass">
            <h2 className="text-lg font-semibold">
              {isAdmin ? t("workspace.entry.noRoles") : t("workspace.entry.noAccess")}
            </h2>
            <p className="mt-3 text-sm text-muted">
              {isAdmin ? (
                <>{t("workspace.entry.adminHint")}</>
              ) : (
                <>{user?.displayName ? t("workspace.entry.noRoleNamed", { name: user.displayName }) : t("workspace.entry.noRole")}</>
              )}
            </p>
            {isAdmin && (
              <div className="mt-4 flex justify-center gap-3 text-sm">
                <Link to="/admin/roles" className="text-primary hover:underline">{t("workspace.entry.goRoles")}</Link>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <HomeChatRoute />
      </div>
    </div>
  );
}
