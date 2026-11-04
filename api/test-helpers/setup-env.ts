// Test-only env bootstrap. Loaded by vitest before any test file imports
// `src/db.ts` (and therefore before Prisma reads DATABASE_URL).
//
// Why this file exists: `resetDb()` in test-helpers/db.ts wipes EVERY row
// in EVERY table. If tests run against the dev database, an innocent
// `pnpm test` destroys the developer's working data (this has happened —
// the regression that motivated this file). Forcing DATABASE_URL to a
// dedicated test SQLite file here makes it impossible to lose dev data
// to a test run, no matter how the test was invoked.
// Use the SAME relative-to-schema URL string that the `pretest` script
// (`prisma migrate deploy`) uses, otherwise migrate-deploy and the test
// process resolve to two different files and tests see "table not found".
//
// Prisma resolves `file:` URLs relative to schema.prisma's directory, so
// `file:./test.db` resolves to api/prisma/test.db (git-ignored).
process.env.DATABASE_URL = "file:./test.db";

// Force NODE_ENV back to "development" — vitest sets it to "test" by default,
// but the project's env enum only allows "development" | "production".
// Tests still get isolation via DATABASE_URL above, not via NODE_ENV.
process.env.NODE_ENV = "development";
// Pin uploads/data to a test-only path so test runs can't dump files into
// the dev DATA_DIR.
process.env.DATA_DIR = process.env.DATA_DIR ?? "./data-test";
