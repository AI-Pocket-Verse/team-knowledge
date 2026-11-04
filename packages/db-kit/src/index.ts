/**
 * @team-knowledge/db-kit
 *
 * Database utilities:
 *   - Prisma WAL bootstrap (SQLite)
 *   - Graceful shutdown
 *   - AES-256-GCM helpers for at-rest encryption of sensitive fields
 *     (used to store Feishu user_access_token / refresh_token)
 *
 * The api owns the Prisma schema; db-kit only ships helpers.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface PrismaLike {
  // PRAGMA statements may or may not return rows depending on the variant —
  // $queryRawUnsafe tolerates both, $executeRawUnsafe rejects rows on SQLite.
  $queryRawUnsafe: (sql: string) => Promise<unknown>
  $disconnect: () => Promise<void>
}

export async function enableWal(prisma: PrismaLike): Promise<void> {
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
  await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;')
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys=ON;')
}

export function gracefulShutdown(prisma: PrismaLike): void {
  const close = async (signal: string) => {
    console.log(`[db-kit] received ${signal}, closing prisma`)
    await prisma.$disconnect()
    process.exit(0)
  }
  process.once('SIGTERM', () => void close('SIGTERM'))
  process.once('SIGINT', () => void close('SIGINT'))
}

// ────────────────────────────────────────────────────────────────────────────
// AES-256-GCM for at-rest token encryption.
// Format: `v1:${iv_b64}:${tag_b64}:${ct_b64}` — stored as a single TEXT column.
// ────────────────────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard

export interface SecretBox {
  encrypt: (plaintext: string) => string
  decrypt: (cipher: string) => string
}

/**
 * Create a SecretBox bound to a 32-byte key.
 * @param keyB64  base64-encoded 32-byte key (e.g. `openssl rand -base64 32`).
 */
export function createSecretBox(keyB64: string): SecretBox {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error(`db-kit: AUTH_DATA_KEY must decode to 32 bytes; got ${key.length}`)
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGO, key, iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
    },
    decrypt(packed: string): string {
      const parts = packed.split(':')
      if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('db-kit: malformed ciphertext')
      }
      const iv = Buffer.from(parts[1]!, 'base64')
      const tag = Buffer.from(parts[2]!, 'base64')
      const ct = Buffer.from(parts[3]!, 'base64')
      const decipher = createDecipheriv(ALGO, key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
  }
}

/** Convenience for ops: print a fresh 32-byte base64 key. */
export function generateDataKey(): string {
  return randomBytes(32).toString('base64')
}
