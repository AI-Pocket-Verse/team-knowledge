import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { createLogger } from '@team-knowledge/logger'

export interface ApiKitOptions {
  service: string
  version?: string
}

/**
 * Standard plugin every api app loads first. Wires:
 *   - structured logging
 *   - error handler returning ApiError shape
 *   - /healthz and /readyz endpoints
 */
const plugin: FastifyPluginAsync<ApiKitOptions> = async (app, opts) => {
  const logger = createLogger({ service: opts.service })
  const startedAt = Date.now()

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) {
      logger.error({ err, url: req.url }, 'unhandled')
      // 5xx errors (e.g. re-thrown Prisma errors) can carry verbose
      // internals — model/field/query fragments — in err.message/err.code.
      // Never leak those to clients; the real error is in the server log
      // above. Send a generic envelope instead. 4xx below keep their
      // intentional, safe messages.
      reply.status(status).send({
        code: 'internal_error',
        message: '服务器内部错误',
      })
      return
    }
    reply.status(status).send({
      code: (err as { code?: string }).code ?? 'internal_error',
      // fastify 5 将 setErrorHandler 的 err 收紧为 unknown,取 message 需断言。
      message: (err as Error).message,
    })
  })

  app.get('/healthz', async () => ({
    status: 'ok' as const,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: opts.version ?? '0.0.0',
  }))

  app.get('/readyz', async () => ({ status: 'ok' }))
}

export default fp(plugin, { name: 'api-kit' })
export { createLogger }
