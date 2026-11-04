// <UserMenu />
//
// Drop-in nav widget:
//   - loading     → small ellipsis placeholder
//   - signed out  → "登录" button → useAuth().loginDirect()
//   - signed in   → avatar + name button → popup menu with optional
//                   "设置" + custom items + "退出登录"(hidden in local mode)
//
// The component renders Tailwind classes. The consumer's tailwind.config.ts
// MUST include this package in its `content` array — see web/tailwind.config.ts.
//
// No icon library dependency — uses inline SVG to stay self-contained.
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useAuth } from './index'

export interface UserMenuItem {
  label: string
  onClick: () => void
  icon?: ReactNode
  /** Optional class override per item (defaults to neutral). */
  className?: string
}

export interface UserMenuProps {
  /** Handler for the "设置" item. Omit to hide it. */
  onSettingsClick?: () => void
  /** Extra menu items inserted between "设置" and "退出登录". */
  items?: UserMenuItem[]
  /** Override the login click behaviour. Default: useAuth().loginDirect(). */
  onLoginClick?: () => void
  /** Override the login button label. Defaults to "登录". */
  loginLabel?: string
  /**
   * Override the "退出登录" action. Default: useAuth().logout(). Products that
   * keep extra local auth state (e.g. their own store) pass their own logout
   * here so it runs alongside the SSO logout + any redirect they need.
   */
  onLogout?: () => void
  /**
   * Replace the default identity detail line (email → mobile) shown under the
   * name with custom content — e.g. a product's own ids. Omit to keep the
   * default. Other products that don't pass it are unaffected.
   */
  subtitle?: ReactNode
  /**
   * Render the signed-in trigger as just the avatar — no name, no chevron, no
   * pill chrome. The popup itself is unchanged.
   */
  avatarOnly?: boolean
  /**
   * 弹窗相对触发器的方向。默认 `bottom-end`(向下、右对齐)——顶栏右上角的用法。
   *
   * **触发器放在页面底部时必须传 `top-start`**,否则弹窗会掉出视口:
   * 实测把用户菜单放到侧栏底部后,向下展开的弹窗顶部落在 y=756、
   * 底部 y=954,而视口高 760 —— 只剩 4px 可见,皮肤切换与退出登录都点不到;
   * 同时 `right-0` 让它右对齐一个靠左的触发器,左边缘跑到 x=-104(屏幕外)。
   * `top-start` 改为向上展开 + 左对齐,两个问题一起解决。
   */
  placement?: 'bottom-end' | 'top-start'
}

/** 方向 → 定位类名。抽出来是为了让上面那段注释有唯一的落点。 */
const PLACEMENT = {
  'bottom-end': 'right-0 top-full mt-2',
  'top-start': 'left-0 bottom-full mb-2',
} as const

export function UserMenu({ onSettingsClick, items, onLoginClick, loginLabel = '登录', onLogout, subtitle, avatarOnly = false, placement = 'bottom-end' }: UserMenuProps) {
  const { user, loading, isLocal, logout, loginDirect } = useAuth()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Click outside / Escape closes the popup
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (loading) {
    return <span className="px-3 py-2 text-xs text-gray-300">…</span>
  }

  if (!user) {
    return (
      <button
        onClick={() => (onLoginClick ? onLoginClick() : loginDirect())}
        className="px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold transition-colors"
      >
        {loginLabel}
      </button>
    )
  }

  const initial = user.name?.[0] ?? '?'
  const avatar = (sizeClass: string) =>
    user.avatar_url ? (
      <img src={user.avatar_url} alt="" className={`${sizeClass} rounded-full object-cover`} />
    ) : (
      <div className={`${sizeClass} rounded-full bg-indigo-200 text-indigo-700 text-xs font-bold flex items-center justify-center`}>
        {initial}
      </div>
    )

  return (
    <div ref={rootRef} className="relative">
      {avatarOnly ? (
        // Minimal trigger: just the avatar. No name/chevron/pill — the popup
        // (which still shows the name) is unchanged. title/aria-label keep the
        // name accessible despite being visually hidden.
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={user.name}
          aria-label={user.name}
          className="block rounded-full ring-1 ring-indigo-100 hover:ring-2 hover:ring-indigo-300 transition-all"
        >
          {avatar('w-8 h-8')}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-indigo-50/60 hover:bg-indigo-100/80 border border-indigo-100 transition-colors"
        >
          {avatar('w-6 h-6')}
          <span className="text-xs font-medium text-gray-700 max-w-[120px] truncate">{user.name}</span>
          <Chevron open={open} />
        </button>
      )}

      {open && (
        <div
          role="menu"
          className={`absolute ${PLACEMENT[placement]} ${subtitle !== undefined ? 'w-60' : 'w-44'} bg-white rounded-2xl shadow-xl shadow-indigo-200/40 border border-indigo-50 py-2 z-50`}
        >
          <div className="px-4 py-3 border-b border-gray-50">
            <p className="text-sm font-semibold text-gray-800 truncate">{user.name}</p>
            {subtitle !== undefined ? (
              <div className="mt-1">{subtitle}</div>
            ) : (
              <>
                {user.email && <p className="text-xs text-gray-400 mt-0.5 truncate">{user.email}</p>}
                {!user.email && user.mobile && <p className="text-xs text-gray-400 mt-0.5 truncate">{user.mobile}</p>}
              </>
            )}
          </div>
          <div className="py-1">
            {onSettingsClick && (
              <MenuRow
                icon={<GearIcon />}
                label="设置"
                onClick={() => { setOpen(false); onSettingsClick() }}
              />
            )}
            {items?.map((it, i) => (
              <MenuRow key={i} icon={it.icon} label={it.label} onClick={() => { setOpen(false); it.onClick() }} className={it.className} />
            ))}
            {!isLocal && (
              <MenuRow
                icon={<LogoutIcon />}
                label="退出登录"
                onClick={() => { setOpen(false); onLogout ? onLogout() : void logout() }}
                className="text-red-500 hover:bg-red-50/60"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MenuRow({ icon, label, onClick, className }: { icon?: ReactNode; label: string; onClick: () => void; className?: string }) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-3 transition-colors ${className ?? 'text-gray-700 hover:bg-indigo-50/60'}`}
    >
      <span className="w-4 h-4 flex-shrink-0">{icon}</span>
      {label}
    </button>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}
