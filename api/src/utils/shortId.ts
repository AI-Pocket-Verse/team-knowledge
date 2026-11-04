import { init } from "@paralleldrive/cuid2";
import { prisma } from "../db.js";

// 8-char lowercase alphanumeric ids for Article / Folder primary keys.
// Alphabet [0-9a-z]; 36^8 ≈ 2.8 trillion combinations. Collisions are
// astronomically rare for this app's scale; we still retry on the
// off-chance to keep create endpoints deterministic.
const generate = init({ length: 8 });

const MAX_RETRIES = 5;

async function uniqueId(
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const id = generate();
    if (!(await exists(id))) return id;
  }
  // Cosmically rare. Fallback to a longer id so we never block a write.
  return init({ length: 16 })();
}

export function uniqueArticleId(): Promise<string> {
  return uniqueId(async (id) => {
    const row = await prisma.article.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  });
}

export function uniqueFolderId(): Promise<string> {
  return uniqueId(async (id) => {
    const row = await prisma.folder.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  });
}

export function uniqueRoleId(): Promise<string> {
  return uniqueId(async (id) => {
    const row = await prisma.role.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  });
}
