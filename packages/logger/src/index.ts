import { pino, type Logger, type LoggerOptions } from 'pino'

export interface CreateLoggerOptions {
  service: string
  level?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  pretty?: boolean
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const isProd = process.env.NODE_ENV === 'production'
  const pretty = opts.pretty ?? !isProd

  const config: LoggerOptions = {
    name: opts.service,
    level: opts.level ?? (isProd ? 'info' : 'debug'),
    base: { service: opts.service, env: process.env.NODE_ENV ?? 'development' },
    redact: {
      paths: ['*.password', '*.token', '*.authorization', 'req.headers.cookie'],
      remove: true,
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  }

  return pino(config)
}

export type { Logger } from 'pino'
