/**
 * @team-knowledge/auth-client-web
 *
 * React SDK for the optional SSO login. No OIDC, no token plumbing — works
 * against the feishu-sso service's REST endpoints only.
 *
 * Omit `ssoBase` for local mode: the user is always LOCAL_USER, no requests
 * are made and login/logout are no-ops.
 *
 *   <AuthProvider config={{ ssoBase: '/auth' }}>
 *     <App />
 *   </AuthProvider>
 *
 *   const { user, loading, login, logout, refresh } = useAuth()
 *
 *   <RequireAuth fallback={<LoginCta />}>...</RequireAuth>   // guard a subtree
 *   <RequireLogin onAuthorized={submit}>                     // guard a single action
 *     <button>Upload</button>
 *   </RequireLogin>
 */
import {
  cloneElement,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

import {
  DEFAULT_SSO_PATHS,
  LOCAL_SESSION,
  LOCAL_USER,
  WhoamiResponse,
  type Session,
  type User,
} from '@team-knowledge/auth-core'

export interface AuthConfig {
  /** Public base path of the SSO service, e.g. `/auth`. Omit for local mode. */
  ssoBase?: string
  /** Override the default `/api/whoami` path. */
  whoamiPath?: string
  /** Override the default `/login` path (branded SSO landing). */
  loginPath?: string
  /** Override the default `/api/feishu/authorize` path (provider entry). */
  directLoginPath?: string
  /** Override the default `/api/logout` path. */
  logoutPath?: string
  /**
   * Optional poll interval to refetch /whoami in milliseconds.
   * Default 0 = no polling; cross-tab updates come via BroadcastChannel.
   */
  pollIntervalMs?: number
}

export interface AuthContextValue {
  user: User | null
  session: Session | null
  loading: boolean
  /** True in local mode (no SSO): there is no login/logout to offer. */
  isLocal: boolean
  /** Redirect to the branded SSO landing page. `returnTo` defaults to current URL. */
  login: (returnTo?: string) => void
  /**
   * Skip the SSO landing and go straight to the IdP authorize endpoint.
   * Preferred for explicit "登录" buttons. Honors a `remember_me` flag.
   */
  loginDirect: (opts?: { returnTo?: string; rememberMe?: boolean }) => void
  /** POST to logout endpoint, then clear local state. */
  logout: () => Promise<void>
  /** Force a /whoami refetch (after manual mutations). */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const BROADCAST_CHANNEL_NAME = 'sso-auth'

function buildUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return trimmedBase + path
}

export interface AuthProviderProps {
  config: AuthConfig
  children: ReactNode
}

export function AuthProvider({ config, children }: AuthProviderProps) {
  if (!config.ssoBase) return createElement(AuthContext.Provider, { value: LOCAL_AUTH }, children)
  return createElement(SsoAuthProvider, { config: { ...config, ssoBase: config.ssoBase }, children })
}

const noop = () => {}
const LOCAL_AUTH: AuthContextValue = {
  user: LOCAL_USER,
  session: LOCAL_SESSION,
  loading: false,
  isLocal: true,
  login: noop,
  loginDirect: noop,
  logout: async () => {},
  refresh: async () => {},
}

function SsoAuthProvider({ config, children }: { config: AuthConfig & { ssoBase: string }; children: ReactNode }) {
  const whoamiUrl = buildUrl(config.ssoBase, config.whoamiPath ?? DEFAULT_SSO_PATHS.whoami)
  const loginUrl = buildUrl(config.ssoBase, config.loginPath ?? DEFAULT_SSO_PATHS.login)
  const directLoginUrl = buildUrl(config.ssoBase, config.directLoginPath ?? '/api/feishu/authorize')
  const logoutUrl = buildUrl(config.ssoBase, config.logoutPath ?? DEFAULT_SSO_PATHS.logout)

  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)
  // StrictMode runs mount → cleanup → mount again. Without resetting to true
  // on every mount, the second mount inherits `false` from the cleanup and
  // refresh() bails before flipping loading=false → spinner sticks forever.
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(whoamiUrl, { credentials: 'include' })
      if (!res.ok) throw new Error(`whoami ${res.status}`)
      const parsed = WhoamiResponse.safeParse(await res.json())
      if (!mountedRef.current) return
      if (parsed.success && parsed.data.authenticated) {
        setUser(parsed.data.user)
        setSession(parsed.data.session)
      } else {
        // whoami answered cleanly that we are NOT authenticated → log out.
        setUser(null)
        setSession(null)
      }
    } catch {
      // We could NOT REACH whoami (network error / 5xx while the API is down or
      // restarting). This is NOT proof of being logged out — clearing the user
      // here makes RequireAuth bounce to /login, which loops forever while the
      // API is briefly unavailable. Leave the existing auth state untouched; a
      // later refresh (poll / visibilitychange / cross-tab) recovers it once the
      // API is back. On the very first load `user` is already null, so a genuine
      // logged-out visitor still falls through to the login redirect.
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [whoamiUrl])

  // Initial load
  useEffect(() => { void refresh() }, [refresh])

  // Optional polling
  useEffect(() => {
    const ms = config.pollIntervalMs ?? 0
    if (ms <= 0) return
    const t = setInterval(() => { void refresh() }, ms)
    return () => clearInterval(t)
  }, [config.pollIntervalMs, refresh])

  // Refetch when the tab becomes visible (covers "logged in elsewhere" case)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  // Cross-tab sync via BroadcastChannel
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    ch.onmessage = (e) => {
      if (e.data === 'signed-in' || e.data === 'signed-out') void refresh()
    }
    return () => ch.close()
  }, [refresh])

  // Detect null→user transition (first whoami after redirect-back from SSO)
  // and notify peer tabs so they refetch immediately rather than waiting for
  // visibilitychange.
  const prevUserId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (prevUserId.current === undefined) {
      prevUserId.current = user?.id ?? null
      return
    }
    if (!prevUserId.current && user) announceSignedIn()
    prevUserId.current = user?.id ?? null
  }, [user])

  const login = useCallback((returnTo?: string) => {
    const to = returnTo ?? window.location.href
    const url = new URL(loginUrl, window.location.origin)
    url.searchParams.set('return_to', to)
    window.location.assign(url.toString())
  }, [loginUrl])

  const loginDirect = useCallback((opts?: { returnTo?: string; rememberMe?: boolean }) => {
    const url = new URL(directLoginUrl, window.location.origin)
    url.searchParams.set('return_to', opts?.returnTo ?? window.location.href)
    url.searchParams.set('remember_me', opts?.rememberMe === false ? '0' : '1')
    window.location.assign(url.toString())
  }, [directLoginUrl])

  const logout = useCallback(async () => {
    try {
      await fetch(logoutUrl, { method: 'POST', credentials: 'include' })
    } catch { /* swallow — still clear local state */ }
    if (mountedRef.current) {
      setUser(null)
      setSession(null)
    }
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      ch.postMessage('signed-out')
      // Defer close — synchronous close on some engines can drop the message
      // before it's dispatched to other tabs.
      setTimeout(() => ch.close(), 100)
    }
  }, [logoutUrl])

  const value = useMemo<AuthContextValue>(
    () => ({ user, session, loading, isLocal: false, login, loginDirect, logout, refresh }),
    [user, session, loading, login, loginDirect, logout, refresh],
  )

  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

/** Hard guard: shows fallback (or auto-redirects) when unauthenticated. */
export interface RequireAuthProps {
  children: ReactNode
  /** Render this when not logged in. If omitted, redirect to SSO login. */
  fallback?: ReactNode
}
export function RequireAuth({ children, fallback }: RequireAuthProps) {
  const { user, loading, login } = useAuth()
  useEffect(() => {
    if (!loading && !user && fallback === undefined) login()
  }, [loading, user, login, fallback])
  if (loading) return null
  if (!user) return (fallback ?? null) as ReactNode
  return children as ReactNode
}

/**
 * Soft guard: wrap an action. Renders children as-is, but intercepts their
 * onClick. If not logged in, redirects to SSO login (with return_to=current
 * page). If logged in, calls onAuthorized after running any child onClick.
 */
export interface RequireLoginProps {
  children: ReactElement<{
    onClick?: (e: React.MouseEvent) => void
    disabled?: boolean
  }>
  onAuthorized: (e: React.MouseEvent) => void
}
export function RequireLogin({ children, onAuthorized }: RequireLoginProps) {
  const { user, login } = useAuth()
  const childOnClick = children.props.onClick
  const childDisabled = children.props.disabled
  const handler = (e: React.MouseEvent) => {
    if (childDisabled) return // honor child's disabled state
    if (!user) {
      e.preventDefault()
      login()
      return
    }
    // Preserve any existing onClick on the child (analytics, propagation, etc.)
    childOnClick?.(e)
    if (e.defaultPrevented) return
    onAuthorized(e)
  }
  return cloneElement(children, { onClick: handler })
}

/** Shared nav widget (avatar + popup menu). Lives in its own file because
 *  it ships JSX; keeping index.ts free of JSX avoids React being a hard
 *  runtime dep for non-UI consumers. */
export { UserMenu, type UserMenuItem, type UserMenuProps } from './UserMenu'

/** Broadcast a sign-in event to peer tabs/products (called by SSO on callback). */
export function announceSignedIn(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const ch = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
  ch.postMessage('signed-in')
  setTimeout(() => ch.close(), 100)
}
