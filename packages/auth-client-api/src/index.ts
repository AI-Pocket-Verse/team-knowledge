/**
 * @team-knowledge/auth-client-api
 *
 * Fastify plugin that decorates request with `req.user` and exposes
 * `app.requireAuth()` and `app.optionalAuth()` preHandlers.
 *
 *   - `whoamiUrl` unset → local mode: every request is LOCAL_USER.
 *   - `whoamiUrl` set   → validates the `sso_session` cookie against the
 *     feishu-sso service's /auth/api/whoami endpoint.
 *
 * Topology: no shared DB, no JWT verification — only HTTP. SSO is the single
 * source of truth.
 */
import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

import {
  DEFAULT_SESSION_COOKIE_NAME,
  LOCAL_SESSION,
  LOCAL_USER,
  WhoamiResponse,
  type Session,
  type User,
} from '@team-knowledge/auth-core'

declare module 'fastify' {
  interface FastifyRequest {
    user?: User | null
    session?: Session | null
    /**
     * True when this request could NOT be authenticated because the SSO
     * service was transiently unreachable / erroring (network blip or 5xx),
     * as opposed to the user being confirmed logged-out. Guards should map
     * this to a retryable 503 (do NOT log the user out) instead of a 401.
     */
    authTransient?: boolean
  }
  interface FastifyInstance {
    requireAuth: () => (req: FastifyRequest) => Promise<void>
    optionalAuth: () => (req: FastifyRequest) => Promise<void>
  }
}

/**
 * Thrown by `verify()` when whoami could not be reached or the SSO service
 * returned a 5xx. Signals "temporarily unavailable, retryable" — NOT
 * "unauthenticated". The onRequest hook catches it and sets
 * `req.authTransient = true` so guards can answer 503 instead of 401.
 */
export class TransientAuthError extends Error {
  readonly code = 'auth_unavailable'
  constructor(message = 'Auth service temporarily unavailable', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransientAuthError'
  }
}

export interface AuthPluginOptions {
  /**
   * Absolute URL to the SSO whoami endpoint, e.g.
   * `http://localhost:4020/api/whoami`. Omit for local single-user mode.
   */
  whoamiUrl?: string
  /** Cookie name carrying the opaque session id. Defaults to `sso_session`. */
  cookieName?: string
  /**
   * Per-cookie LRU cache TTL for positive whoami results. Set 0 to disable.
   * Defaults to 5_000 ms — kept short so logout / disable / needs-relogin
   * propagate quickly (the cache is not invalidated on those events).
   */
  cacheTtlMs?: number
  /** Max cache entries. Defaults to 5000. */
  cacheMax?: number
  /** whoami 请求超时(毫秒)，超时按「登录服务暂时不可用」(503)处理，不当作未登录。默认 5000。 */
  timeoutMs?: number
  /** Inject a custom fetch (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

interface CacheEntry {
  value: { user: User; session: Session } | null
  expiresAt: number
}

// 同域其他应用可能写入畸形 cookie(如 `a=%`)，解码失败时保留原值，不能让整个请求 500。
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const k = piece.slice(0, eq).trim()
    const v = piece.slice(eq + 1).trim()
    if (k) out[k] = safeDecode(v)
  }
  return out
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const cookieName = opts.cookieName ?? DEFAULT_SESSION_COOKIE_NAME
  const ttl = opts.cacheTtlMs ?? 5_000
  const max = opts.cacheMax ?? 5000
  const fetchFn = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 5_000
  const cache = new Map<string, CacheEntry>()

  const verify = async (whoamiUrl: string, sessionId: string): Promise<{ user: User; session: Session } | null> => {
    const now = Date.now()
    if (ttl > 0) {
      const hit = cache.get(sessionId)
      if (hit && hit.expiresAt > now) {
        // Stale-authz guard: a positive entry only caches the whoami snapshot,
        // not live session state. If the cached session has since expired,
        // treat the hit as a miss and revalidate against whoami (which also
        // re-checks disabled / needs_relogin server-side).
        const sessionExpiry = hit.value ? Date.parse(hit.value.session.expires_at) : NaN
        if (hit.value && Number.isFinite(sessionExpiry) && sessionExpiry <= now) {
          cache.delete(sessionId)
        } else {
          // True LRU: move this entry to the end of iteration order on read.
          cache.delete(sessionId)
          cache.set(sessionId, hit)
          return hit.value
        }
      } else if (hit) {
        // Expired cache entry — drop now so a stale negative can't linger.
        cache.delete(sessionId)
      }
    }

    let res: Response
    try {
      res = await fetchFn(whoamiUrl, {
        method: 'GET',
        headers: { Cookie: `${cookieName}=${encodeURIComponent(sessionId)}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      // Network blip / auth service unreachable → transient, retryable.
      // Do NOT treat as logged-out (that would bounce the user to /login).
      throw new TransientAuthError('Auth service unreachable', { cause: e })
    }

    // 5xx = auth service is up but erroring (restart / crash) → transient.
    // 429 = 被限流，不代表用户未登录，同样按瞬时故障处理(否则前端会跳登录页形成循环)。
    if (res.status >= 500 || res.status === 429) {
      throw new TransientAuthError(`Auth service returned ${res.status}`)
    }

    let parsed: { user: User; session: Session } | null = null
    if (res.ok) {
      let body: unknown
      try {
        body = await res.json()
      } catch (e) {
        // 读响应体超时 / 非 JSON：auth 服务异常，不是「未登录」。
        throw new TransientAuthError('Auth service returned an unreadable response', { cause: e })
      }
      const out = WhoamiResponse.safeParse(body)
      if (out.success && out.data.authenticated) {
        parsed = { user: out.data.user, session: out.data.session }
      }
      // res.ok but authenticated:false → confirmed logged-out → parsed stays null.
    }
    // 4xx (401/404/…) → auth definitively says not-authenticated → parsed stays null.

    // Only cache positives. Caching null would make logout / re-login feel sticky
    // (the old session id would map to "unauthenticated" for 30 s after a fresh
    // login swapped the cookie). It would also delay admin-side disable for the
    // same window.
    if (ttl > 0 && parsed) {
      if (cache.size >= max) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(sessionId, { value: parsed, expiresAt: now + ttl })
    }
    return parsed
  }

  app.decorateRequest('user', null)
  app.decorateRequest('session', null)
  app.decorateRequest('authTransient', false)

  const whoamiUrl = opts.whoamiUrl
  app.addHook('onRequest', async (req) => {
    // Local mode: no SSO configured → everyone is the single local user.
    if (!whoamiUrl) {
      req.user = LOCAL_USER
      req.session = LOCAL_SESSION
      return
    }
    const cookies = parseCookies(req.headers.cookie)
    const sid = cookies[cookieName]
    if (!sid) return
    try {
      const v = await verify(whoamiUrl, sid)
      if (v) {
        req.user = v.user
        req.session = v.session
      }
    } catch (e) {
      if (e instanceof TransientAuthError) {
        // SSO temporarily unavailable — leave req.user null but mark the
        // request so guards answer a retryable 503 instead of logging out.
        req.authTransient = true
      }
      // Any other error: swallow → treated as unauthenticated (req.user null).
    }
  })

  app.decorate('requireAuth', () => async (req: FastifyRequest) => {
    if (!req.user) {
      const err = new Error('Unauthorized') as Error & { statusCode?: number; code?: string }
      if (req.authTransient) {
        err.message = '登录服务暂时不可用,请稍后重试'
        err.statusCode = 503
        err.code = 'auth_unavailable'
      } else {
        err.statusCode = 401
        err.code = 'unauthenticated'
      }
      throw err
    }
  })

  app.decorate('optionalAuth', () => async () => {
    // No-op preHandler — req.user already populated (or null) by onRequest.
  })
}

export default fp(plugin, { name: 'auth-client' })
