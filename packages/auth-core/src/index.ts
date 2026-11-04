/**
 * @team-knowledge/auth-core
 *
 * Shared schemas for the optional SSO login.
 *
 * Two modes:
 *   - Local mode (default): no SSO configured. Every request acts as the fixed
 *     LOCAL_USER below — single-user, nothing to set up.
 *   - SSO mode: a stateful session held by the companion `feishu-sso` service.
 *     Browsers carry an opaque `sso_session` cookie; SDKs verify it by calling
 *     `GET /auth/api/whoami` against that service.
 *
 * No JWT, no OIDC. In SSO mode all identity comes from Feishu via feishu-sso.
 */
import { z } from 'zod'

/** Public-facing user record returned by /auth/api/whoami.
 *
 * Identity provider fields use plain `z.string().nullable().optional()` — no
 * `.email()` / `.url()` constraints. Feishu can return empty strings for
 * missing values (not null), and we don't want zod to reject the whole payload
 * because the avatar URL is empty. Treat empty string as "no value" at the
 * display layer instead.
 */
export const User = z.object({
  id: z.string(),
  open_id: z.string(),
  union_id: z.string().nullable().optional(),
  name: z.string(),
  en_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  mobile: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  avatar_thumb: z.string().nullable().optional(),
  tenant_key: z.string().nullable().optional(),
  /** ISO-8601 */
  last_login_at: z.string(),
})
export type User = z.infer<typeof User>

/** Public-facing session metadata returned by /auth/api/whoami. */
export const Session = z.object({
  id: z.string(),
  user_id: z.string(),
  remember_me: z.boolean(),
  /** ISO-8601 */
  expires_at: z.string(),
  /** ISO-8601 */
  last_seen_at: z.string(),
})
export type Session = z.infer<typeof Session>

/** Response body of GET /auth/api/whoami. */
export const WhoamiResponse = z.union([
  z.object({ authenticated: z.literal(true), user: User, session: Session }),
  z.object({ authenticated: z.literal(false) }),
])
export type WhoamiResponse = z.infer<typeof WhoamiResponse>

/**
 * Default cookie name. Override via env if needed; all SDKs read this from
 * config rather than hard-coding it.
 */
export const DEFAULT_SESSION_COOKIE_NAME = 'sso_session'

/**
 * Local mode identity: api and web both fall back to this when no SSO is
 * configured, so data written in local mode has one stable owner id.
 */
export const LOCAL_USER: User = {
  id: 'local',
  open_id: 'local',
  name: '本地用户',
  last_login_at: '1970-01-01T00:00:00.000Z',
}
export const LOCAL_SESSION: Session = {
  id: 'local',
  user_id: 'local',
  remember_me: true,
  expires_at: '9999-12-31T23:59:59.999Z',
  last_seen_at: '1970-01-01T00:00:00.000Z',
}

/** Default paths under SSO base; SDKs accept overrides. */
export const DEFAULT_SSO_PATHS = {
  whoami: '/api/whoami',
  login: '/login',
  logout: '/api/logout',
  touch: '/api/session/touch',
} as const
