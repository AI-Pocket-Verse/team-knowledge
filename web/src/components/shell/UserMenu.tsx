import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth as useSsoUser } from "@team-knowledge/auth-client-web";
import { useAuth } from "@/stores/auth";
import { useAdminAccess, firstAdminPath } from "@/lib/adminAccess";
import { tr, useI18n, useT, type LangPref } from "@/i18n";

/**
 * Top-right identity menu — a team-knowledge-local Feishu-style dropdown (no longer
 * the platform-shared `<UserMenu>`, so it can be skinned freely here), wired to
 * team-knowledge's navigation:
 *   - "数据看板" → /dashboard (ALL users; the aggregate dashboard is public,
 *     the per-user table + drill-down inside it stay admin-only)
 *   - "个人主页" → /me/profile
 *   - "管理后台" → /admin/users (admin-only; lives here so all
 *     identity/management entries sit in one popup, directly under 个人主页)
 *   - "回收站" → /recycle-bin
 *   - "关于" → /about
 *   - "退出登录" runs team-knowledge's own logout (clears the local auth store AND
 *     redirects to the SSO login page) rather than only resetting the SSO
 *     context — team-knowledge's route gate reads the local store, so it must clear.
 */
export function UserMenu() {
  const navigate = useNavigate();
  const logout = useAuth((s) => s.logout);
  const adminAccess = useAdminAccess();
  // Show the two ids people actually need (e.g. to run the user-merge tool):
  // the team-knowledge local user_id (from our own store) and the stable Feishu
  // open_id (from the SSO context).
  const userId = useAuth((s) => s.user?.id ?? null);
  // displayName from the local auth store; fall back to the SSO user's name
  // when the local store hasn't hydrated yet.
  const localUser = useAuth((s) => s.user);
  const { user: ssoUser, isLocal } = useSsoUser();
  const openId = ssoUser?.open_id ?? null;
  const displayName = localUser?.displayName || ssoUser?.name || tr("shell.user.signedOut");
  // 真实飞书头像:本地 user 优先,回退 SSO 头像;都没有则 Avatar 回退渐变首字母。
  const avatarUrl = localUser?.avatarUrl || ssoUser?.avatar_url || null;

  const { pref, setPref, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click outside / Escape closes the popup.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 数据看板 + 个人主页 visible to ALL users (the dashboard page itself gates the
  // per-user table / drill-down to admins). 管理后台 only for admins (the /admin
  // route is itself gated by <RequireManagement>; hiding the entry just keeps the
  // menu clean for non-admins). 回收站 + 关于 last, directly above 退出登录.
  const items: { label: string; icon: React.ReactNode; onClick: () => void }[] = [
    { label: t("shell.page.dashboard"), icon: <ChartIcon />, onClick: () => navigate("/dashboard") },
    { label: t("shell.page.profile"), icon: <PersonIcon />, onClick: () => navigate("/me/profile") },
    ...(adminAccess.canEnter ? [{ label: t("shell.page.admin"), icon: <AdminIcon />, onClick: () => navigate(firstAdminPath(adminAccess.isAdmin, adminAccess.openPages)) }] : []),
    { label: t("shell.page.recycleBin"), icon: <RecycleIcon />, onClick: () => navigate("/recycle-bin") },
    { label: t("shell.page.about"), icon: <AboutIcon />, onClick: () => navigate("/about") },
  ];

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger: avatar-only (no name/chevron) — matches the prior avatarOnly look. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={displayName}
        aria-label={displayName}
        className="block rounded-full ring-1 ring-line transition-all hover:ring-2 hover:ring-primary/30"
      >
        <Avatar name={displayName} url={avatarUrl} sizeClass="h-8 w-8" textClass="text-sm" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-line bg-white py-2 shadow-glassLg"
        >
          {/* Identity header: large gradient avatar + name + id rows. */}
          <div className="flex items-start gap-3 border-b border-line px-4 pb-3 pt-1">
            <Avatar name={displayName} url={avatarUrl} sizeClass="h-11 w-11" textClass="text-base" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-fg">{displayName}</p>
              {!isLocal && <IdentityIds userId={userId} openId={openId} />}
            </div>
          </div>

          <div className="py-1">
            {items.map((it) => (
              <MenuRow
                key={it.label}
                icon={it.icon}
                label={it.label}
                onClick={() => { setOpen(false); it.onClick(); }}
              />
            ))}
          </div>

          {/* 界面语言：跟随系统 / 中文 / English，选择记在本机。 */}
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-sm text-fg/85">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center"><GlobeIcon /></span>
            <div className="flex gap-1" role="group" aria-label={t("menu.language", { name: t(`menu.language.${pref}`) })}>
              {(["system", "zh", "en"] as LangPref[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="menuitemradio"
                  aria-checked={pref === p}
                  onClick={() => { setOpen(false); setPref(p); }}
                  className={`rounded-md px-2 py-0.5 text-xs transition ${pref === p ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface hover:text-primary"}`}
                >
                  {t(`menu.language.${p}`)}
                </button>
              ))}
            </div>
          </div>

          {/* 本地单用户模式没有账号可退出 */}
          {!isLocal && (
            <div className="border-t border-line pt-1">
              <MenuRow
                icon={<LogoutIcon />}
                label={t("shell.user.logout")}
                danger
                onClick={() => { setOpen(false); void logout(); }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Gradient (blue→violet) initial avatar. Uses displayName: first char for a
// single-char/Latin name, last two chars for a longer CJK name.
function Avatar({
  name,
  url,
  sizeClass,
  textClass,
}: {
  name: string;
  url?: string | null;
  sizeClass: string;
  textClass: string;
}) {
  const [broken, setBroken] = useState(false);
  // 有真实头像且未加载失败 → 渲染飞书头像图;否则回退渐变首字母。
  if (url && !broken) {
    return (
      <img
        src={url}
        alt={name}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover ${sizeClass}`}
      />
    );
  }
  const initials = avatarInitials(name);
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 font-semibold text-white ${sizeClass} ${textClass}`}
      aria-hidden
    >
      {initials}
    </span>
  );
}

function avatarInitials(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  // CJK / longer names → last two characters; otherwise the first character.
  if (n.length >= 2 && /[一-龥]/.test(n)) return n.slice(-2);
  return n.slice(0, 1).toUpperCase();
}

function MenuRow({
  icon, label, onClick, danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition ${
        danger
          ? "text-rose-600 hover:bg-rose-50"
          : "text-fg/85 hover:bg-surface hover:text-primary"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      {label}
    </button>
  );
}

// The popup's identity detail: user_id + open_id, each click-to-copy. Kept
// here (not in the shared package) because user_id is team-knowledge-specific.
function IdentityIds({ userId, openId }: { userId: string | null; openId: string | null }) {
  return (
    <div className="mt-0.5 space-y-1">
      <CopyId label="user_id" value={userId} />
      <CopyId label="open_id" value={openId} />
    </div>
  );
}

function CopyId({ label, value }: { label: string; value: string | null }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked (e.g. http) — the title tooltip still shows the value */
      });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={t("shell.user.copyTip", { label, value })}
      className="flex w-full items-center gap-1.5 text-left"
    >
      <span className="w-[52px] shrink-0 text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="flex-1 truncate font-mono text-[11px] text-muted">{value}</span>
      <span className={`shrink-0 text-[10px] ${copied ? "text-emerald-500" : "text-primary"}`}>
        {copied ? t("common.copied") : t("common.copy")}
      </span>
    </button>
  );
}

// Inline person glyph for the "个人主页" row.
function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

// Bar-chart glyph for the "数据看板" row.
function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M8 17v-4" />
      <path d="M13 17v-7" />
      <path d="M18 17v-10" />
    </svg>
  );
}

// Dashboard/grid glyph for the admin-console ("管理后台") row.
function AdminIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

// Trash-can glyph for the "回收站" row.
function RecycleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// Info "i" glyph for the "关于" row.
function AboutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

// Door/arrow glyph for the "退出登录" row.
function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
