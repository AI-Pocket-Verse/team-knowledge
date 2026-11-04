import type { PrismaClient } from "@prisma/client";

// Matches `/uploads/<cuid>.<ext>` where ext is 1-8 alphanumeric chars.
// We accept any extension because non-image uploads (POST /api/uploads/file)
// can land here with .pdf / .docx / .csv / .zip etc. — Plan A attachments.
// Path safety is enforced separately by the server route's stricter regex.
const UPLOAD_URL_RE = /\/uploads\/([a-z0-9]+\.[a-z0-9]{1,8})/gi;

// Strip fenced code blocks and inline code spans before running the
// URL regex. Without this, an article that quotes an example upload
// URL inside ```...``` or `...` would mistakenly bind that upload to
// itself — and because binding is first-write-wins, it would
// permanently steal the permission anchor from the article that
// actually owns the file.
//
// We use a line-by-line state machine instead of the lazy regex
// `/```[\s\S]*?```/g`: an unclosed fence (user typed ``` but never
// closed it) would make the lazy regex match from the opening to the
// next fence elsewhere in the doc, stripping real content — including
// genuine upload URLs — and undoing the protection we wanted. The
// state machine treats an unclosed fence as "everything to EOF is
// fenced", which is the safe interpretation: no false-bind from
// inside an open code block.
function stripCode(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const raw of lines) {
    const line = raw.trimEnd();
    const fenceMatch = line.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0];
      } else if (marker[0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue; // drop the fence line itself
    }
    if (inFence) continue;
    // Drop inline `code` from the line before keeping it.
    out.push(raw.replace(/`[^`\n]*`/g, ""));
  }
  return out.join("\n");
}

/** Extract every `/uploads/<filename>` reference from article markdown. */
export function extractUploadFilenames(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of stripCode(markdown).matchAll(UPLOAD_URL_RE)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * First-bind semantics: every Upload row referenced by this article's markdown
 * gets its `articleId` set to this article — but only if the upload was not
 * already bound to a (potentially different) article. This keeps an image's
 * permission anchor stable: it's whichever article first embedded it.
 *
 * Why first-bind rather than rebind-on-every-save: if two articles embed the
 * same image and one removes the reference, we still need the other one's
 * permission scope to apply, which would be lost if we unbound aggressively.
 * First-bind is good enough for the typical "paste once, keep visible" flow.
 */
export async function bindUploadsToArticle(
  tx: Pick<PrismaClient, "upload">,
  articleId: string,
  markdown: string,
): Promise<void> {
  const filenames = extractUploadFilenames(markdown);
  if (filenames.length === 0) return;
  await tx.upload.updateMany({
    where: { filename: { in: filenames }, articleId: null },
    data: { articleId },
  });
}
