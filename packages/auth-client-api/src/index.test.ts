import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { LOCAL_USER } from '@team-knowledge/auth-core'

import authPlugin from './index'

async function build(opts: Parameters<typeof authPlugin>[1]) {
  const app = Fastify()
  await app.register(authPlugin, opts)
  app.get('/me', { preHandler: app.requireAuth() }, async (req) => ({ id: req.user!.id }))
  return app
}

describe('auth-client-api', () => {
  it('local mode (no whoamiUrl): every request is LOCAL_USER', async () => {
    const app = await build({})
    const res = await app.inject({ url: '/me' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: LOCAL_USER.id })
  })

  it('SSO mode without a session cookie → 401', async () => {
    const fetchImpl = (async () => {
      throw new Error('whoami must not be called without a cookie')
    }) as typeof fetch
    const app = await build({ whoamiUrl: 'http://sso.invalid/api/whoami', fetchImpl })
    const res = await app.inject({ url: '/me' })
    expect(res.statusCode).toBe(401)
  })

  it('SSO mode with a valid session → whoami user', async () => {
    const user = { ...LOCAL_USER, id: 'u1', open_id: 'ou_1', name: 'Alice' }
    const session = { id: 's1', user_id: 'u1', remember_me: false, expires_at: '2999-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z' }
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ authenticated: true, user, session }), { status: 200 })) as typeof fetch
    const app = await build({ whoamiUrl: 'http://sso.invalid/api/whoami', fetchImpl })
    const res = await app.inject({ url: '/me', headers: { cookie: 'sso_session=abc' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'u1' })
  })

  it('SSO mode when whoami is unreachable → retryable 503', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const app = await build({ whoamiUrl: 'http://sso.invalid/api/whoami', fetchImpl })
    const res = await app.inject({ url: '/me', headers: { cookie: 'sso_session=abc' } })
    expect(res.statusCode).toBe(503)
  })

  it('whoami 超时 → 503 而不是一直挂住', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))
      })) as typeof fetch
    const app = await build({ whoamiUrl: 'http://sso.invalid/api/whoami', fetchImpl, timeoutMs: 50 })
    const res = await app.inject({ url: '/me', headers: { cookie: 'sso_session=abc' } })
    expect(res.statusCode).toBe(503)
  })

  it('whoami 返回 429(被限流) → 503，不当作未登录', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 429 })) as typeof fetch
    const app = await build({ whoamiUrl: 'http://sso.invalid/api/whoami', fetchImpl })
    const res = await app.inject({ url: '/me', headers: { cookie: 'sso_session=abc' } })
    expect(res.statusCode).toBe(503)
  })

  it('畸形 cookie(a=%)不会让请求 500，会话 cookie 仍可识别', async () => {
    const user = { ...LOCAL_USER, id: 'u1', open_id: 'ou_1', name: 'Alice' }
    const session = { id: 's1', user_id: 'u1', remember_me: false, expires_at: '2999-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z' }
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ authenticated: true, user, session }), { status: 200 })) as typeof fetch
    const app = await build({ whoamiUrl: 'http://sso.invalid/api/whoami', fetchImpl })
    for (const cookie of ['other=%E0%A4%A; sso_session=abc', 'other=100%; sso_session=abc']) {
      const res = await app.inject({ url: '/me', headers: { cookie } })
      expect(res.statusCode, cookie).toBe(200)
    }
  })
})
