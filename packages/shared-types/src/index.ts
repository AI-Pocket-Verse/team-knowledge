/**
 * Cross-tier contracts shared between web and api packages.
 * Anything imported by both sides belongs here as a zod schema (so types
 * derive from the same source as runtime validation).
 */
import { z } from 'zod'

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
})
export type PaginationQuery = z.infer<typeof PaginationQuery>

export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiError>

export const HealthStatus = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  uptime: z.number(),
  version: z.string(),
})
export type HealthStatus = z.infer<typeof HealthStatus>
