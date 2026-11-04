import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import type { PrismaClient } from "@prisma/client";
import { env } from "../env.js";
import { extractUploadFilenames } from "./uploadBinding.js";

const UPLOAD_DIR = resolve(env.DATA_DIR, "uploads");

/**
 * Sanitize a user-supplied filename for safe inclusion in a zip's
 * `assets/` directory. Strips path-traversal, drops directory
 * separators, falls back to `attachment` if nothing usable remains.
 * Trims to 100 chars so an originalName like "<200-char-name>.pdf"
 * doesn't bloat the zip's central directory.
 */
function sanitizeZipName(name: string): string {
  const trimmed = name.replace(/[\\/]/g, "_").replace(/\0/g, "").trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "attachment";
  return trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
}

/**
 * Pick a unique entry name inside the zip's `assets/` directory.
 * If `base` is already taken, append `_1`, `_2`, ... before the
 * extension so two uploads with the same originalName don't clobber.
 */
function pickUniqueName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Vanishingly unlikely: fall back to a timestamp-suffixed name.
  const fallback = `${stem}_${Date.now()}${ext}`;
  taken.add(fallback);
  return fallback;
}

export interface ExportBundle {
  /** Final byte content of the response. */
  body: Buffer | string;
  /** MIME for the Content-Type header. */
  contentType: string;
  /** Suggested download filename without directory parts. */
  filename: string;
}

/**
 * Build either a plain `.md` response or a `.zip` bundle (markdown
 * with rewritten asset URLs + `assets/` containing every referenced
 * upload). Behaviour switches automatically based on whether the
 * article references any `/uploads/...` files.
 *
 * Uploads referenced in the markdown but missing from disk are
 * skipped — the markdown link stays as-is so the user at least sees
 * which file was missing.
 */
export async function buildArticleExport(
  prisma: Pick<PrismaClient, "upload">,
  article: {
    title: string;
    contentMarkdown: string;
    createdAt: Date;
    updatedAt: Date;
    createdBy: { displayName: string } | null;
    // folder is optional — null for role-direct docs.
    folder: { name: string; role: { name: string } } | null;
    // role is now always loaded directly off the article.
    role: { name: string };
  },
): Promise<ExportBundle> {
  const safeTitle = article.title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80) || "article";

  // YAML front-matter `title:` is a single double-quoted scalar on ONE
  // line. A title containing a newline (or other control char) would break
  // out of the quoted string and corrupt the front-matter, so collapse any
  // CR/LF/control whitespace to a single space BEFORE escaping the quotes.
  const yamlTitle = article.title.replace(/[\r\n\t\f\v]+/g, " ").replace(/"/g, '\\"');

  // For role-direct docs we drop the `folder:` line entirely; the
  // export YAML stays consistent (each present line still parses) and
  // a downstream importer can tell "no folder" from the absence.
  const yaml =
    `---\n` +
    `title: "${yamlTitle}"\n` +
    // 名称可能含 `:` / `#` 等 YAML 特殊字符,统一按 JSON 字符串输出(JSON 是 YAML 的子集)。
    `author: ${JSON.stringify(article.createdBy?.displayName ?? "(deleted)")}\n` +
    `role: ${JSON.stringify(article.role.name)}\n` +
    (article.folder ? `folder: ${JSON.stringify(article.folder.name)}\n` : ``) +
    `createdAt: ${article.createdAt.toISOString()}\n` +
    `updatedAt: ${article.updatedAt.toISOString()}\n` +
    `---\n`;

  const filenames = extractUploadFilenames(article.contentMarkdown);
  // Fast path: no uploads → ship plain .md so users that don't need
  // assets keep getting a single textual file.
  if (filenames.length === 0) {
    return {
      body: yaml + article.contentMarkdown,
      contentType: "text/markdown; charset=utf-8",
      filename: `${safeTitle}.md`,
    };
  }

  const uploads = await prisma.upload.findMany({
    where: { filename: { in: filenames } },
    select: { filename: true, originalName: true },
  });
  const uploadIndex = new Map(uploads.map((u) => [u.filename, u]));

  // Build zip: rewrite `/uploads/<storage>` → `./assets/<zipName>`
  // and add each referenced file's bytes under `assets/`. Filenames
  // missing from disk or the DB are left as-is in the markdown so
  // the user sees what went wrong.
  let rewritten = article.contentMarkdown;
  const zip = new JSZip();
  const assets = zip.folder("assets");
  if (!assets) {
    // Defensive: JSZip's .folder() returns null only when the path is
    // invalid (e.g. ".."). "assets" is a valid relative name, but
    // satisfying the type narrowing this way keeps the rest of the
    // function strictly typed.
    throw new Error("could not create zip folder");
  }
  const takenNames = new Set<string>();
  for (const filename of filenames) {
    const meta = uploadIndex.get(filename);
    if (!meta) continue; // unknown filename — leave URL alone
    let bytes: Buffer;
    try {
      bytes = await readFile(join(UPLOAD_DIR, filename));
    } catch {
      continue; // file missing on disk — leave URL alone
    }
    const desired = sanitizeZipName(meta.originalName ?? filename);
    const zipName = pickUniqueName(takenNames, desired);
    assets.file(zipName, bytes);
    // Replace every `/uploads/<filename>` occurrence (the regex is
    // intentionally simple — `extractUploadFilenames` already
    // de-duplicated, and the markdown is plain text so no escaping
    // surprises).
    const needle = `/uploads/${filename}`;
    rewritten = rewritten.split(needle).join(`./assets/${encodeURIComponent(zipName)}`);
  }
  zip.file(`${safeTitle}.md`, yaml + rewritten);

  const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    body,
    contentType: "application/zip",
    filename: `${safeTitle}.zip`,
  };
}
