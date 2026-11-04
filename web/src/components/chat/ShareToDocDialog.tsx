import { useEffect, useMemo, useState } from "react";
import type { ChatMessageRow, WorkspaceRole, FolderRow } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { cn } from "@/lib/cn";
import { useAuth } from "@/stores/auth";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { chatCardUserLabel, chatCardAssistantLabel } from "./chatCardLabels";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT } from "@/i18n";

// Share selected chat messages into a brand-new knowledge-base document.
// The doc body is built CLIENT-SIDE from the selected Q&A turns and saved
// via the existing api.articles.create — no dedicated backend route.
//
// Destination (decided in product): an EXISTING role the user can write to
// (+ optionally a new folder under it), OR — admins only — a freshly created
// role. The doc is created as an ARCHIVED (read-only) snapshot — see submit().

const NEW = "__new__";
const ROOT = "__root__";

// Build the markdown body from the selected messages. Each message
// becomes a blockquote "card": a bold role-label line, a blank quoted
// line, then the message body — every line quoted so the label + body
// stay inside a SINGLE blockquote node. The read view styles those
// blockquotes as chat cards and adds a per-card 复制 button (see
// useChatCardEnhancer); the doc itself is created archived/read-only.
// We include the question + answer text only (no raw 深度思考 trace).
export function buildShareMarkdown(messages: ChatMessageRow[]): string {
  const blocks: string[] = [tr("chat.share.excerptFrom", { name: getAssistantName() }), ""];
  for (const m of messages) {
    const label = m.role === "user" ? chatCardUserLabel() : chatCardAssistantLabel();
    const images = m.images ?? [];
    const hasContent = m.content.trim().length > 0;
    blocks.push(`> **${label}**`, ">");
    // Attached images first (matches the chat UI's 图在上、文字在下). Each is a
    // quoted markdown image so it stays inside this card's single blockquote;
    // urls are the raw /uploads/<file> the row carries (stored as-is in the doc).
    for (const url of images) blocks.push(`> ![${tr("chat.share.imageAlt")}](${url})`);
    if (images.length && hasContent) blocks.push(">");
    // Show body text when there is any — or the placeholder only when the card
    // would otherwise be empty (no text AND no images).
    if (hasContent || images.length === 0) {
      const body = m.content.trim() || (m.role === "user" ? tr("chat.share.emptyUser") : tr("chat.share.emptyAi"));
      const quotedBody = body
        .split("\n")
        .map((line) => (line.length ? `> ${line}` : ">"))
        .join("\n");
      blocks.push(quotedBody);
    }
    blocks.push("");
  }
  return blocks.join("\n").trimEnd() + "\n";
}

export function ShareToDocDialog({
  messages, onClose, onShared,
}: {
  messages: ChatMessageRow[];
  onClose: () => void;
  /** Called after the doc is created; receives the new article id. */
  onShared: (articleId: string) => void;
}) {
  const t = useT();
  const isAdmin = useAuth((s) => Boolean(s.user?.isAdmin));
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);

  const [title, setTitle] = useState(tr("chat.share.defaultTitle", { name: getAssistantName() }));
  const [roles, setRoles] = useState<WorkspaceRole[] | null>(null);
  const [roleSel, setRoleSel] = useState<string>(""); // role id | NEW
  const [newRoleName, setNewRoleName] = useState("");
  const [folders, setFolders] = useState<FolderRow[] | null>(null);
  const [folderSel, setFolderSel] = useState<string>(ROOT); // ROOT | NEW | folderId
  const [newFolderName, setNewFolderName] = useState("");
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const markdown = useMemo(() => buildShareMarkdown(messages), [messages]);

  // Load the roles the caller can write to (ownership === "owned"). Read-only
  // roles can't host a new doc, so they're filtered out.
  useEffect(() => {
    let alive = true;
    api.workspace.listRoles()
      .then((r) => {
        if (!alive) return;
        const owned = r.roles.filter((x) => x.ownership === "owned");
        setRoles(owned);
        setRoleSel(owned[0]?.id ?? (isAdmin ? NEW : ""));
      })
      .catch((e) => { if (alive) { setRoles([]); toast.error(e instanceof ApiError ? e.message : t("chat.shareDoc.loadRolesFailed")); } });
    return () => { alive = false; };
  }, [isAdmin]);

  // Load the selected role's folders for the folder dropdown. New-role mode
  // has no folders to show (only 根目录 / 新建目录).
  useEffect(() => {
    setFolderSel(ROOT);
    if (!roleSel || roleSel === NEW) { setFolders(null); return; }
    let alive = true;
    setLoadingFolders(true);
    api.workspace.tree(roleSel)
      .then((t) => { if (alive) setFolders(t.folders); })
      .catch(() => { if (alive) setFolders([]); })
      .finally(() => { if (alive) setLoadingFolders(false); });
    return () => { alive = false; };
  }, [roleSel]);

  const canSubmit =
    !submitting &&
    messages.length > 0 &&
    title.trim().length > 0 &&
    (roleSel === NEW ? newRoleName.trim().length > 0 : roleSel.length > 0) &&
    (folderSel !== NEW || newFolderName.trim().length > 0);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 1) Resolve the destination role (creating it first if requested).
      let roleId = roleSel;
      if (roleSel === NEW) {
        const r = await api.admin.createRole({ name: newRoleName.trim() });
        roleId = r.role.id;
      }
      // 2) Resolve the destination folder (null = role-direct).
      let folderId: string | null = null;
      if (folderSel === NEW) {
        const f = await api.folders.create({ name: newFolderName.trim(), visibility: "public", roleId });
        folderId = f.folder.id;
      } else if (folderSel !== ROOT) {
        folderId = folderSel;
      }
      // 3) 从拼好的 markdown 创建文档(去状态后无归档/只读快照概念,即普通文档)。
      const res = await api.articles.create({ roleId, folderId, title: title.trim(), contentMarkdown: markdown });
      requestRoleRefresh(roleId); // nudge the left rail to show the new doc
      toast.success(t("chat.shareDoc.saved"));
      onShared(res.article.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
      setSubmitting(false); // keep the dialog open so the user can retry / fix
    }
  }

  const noWritableRole = roles !== null && roles.length === 0 && !isAdmin;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-white shadow-glassLg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-base font-semibold text-fg">{t("chat.shareDoc.title")}</div>
          <div className="text-xs text-muted">{t("chat.shareDoc.selected", { n: messages.length })}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {noWritableRole ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              {t("chat.shareDoc.noRole")}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">{t("chat.shareDoc.docTitle")}</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={255}
                  className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                  placeholder={t("chat.shareDoc.titlePlaceholder")}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">{t("chat.shareDoc.saveToRole")}</span>
                <select
                  value={roleSel}
                  onChange={(e) => setRoleSel(e.target.value)}
                  disabled={roles === null}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  {roles === null && <option value="">{t("common.loading")}</option>}
                  {(roles ?? []).map((r) => (
                    <option key={r.id} value={r.id}>👤 {r.name}</option>
                  ))}
                  {isAdmin && <option value={NEW}>{t("chat.shareDoc.newRoleOption")}</option>}
                </select>
              </label>

              {roleSel === NEW && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">{t("chat.shareDoc.newRoleName")}</span>
                  <input
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    maxLength={50}
                    className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                    placeholder={t("chat.shareDoc.newRolePlaceholder")}
                  />
                </label>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">{t("chat.shareDoc.saveToFolder")}</span>
                <select
                  value={folderSel}
                  onChange={(e) => setFolderSel(e.target.value)}
                  disabled={loadingFolders}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value={ROOT}>{t("chat.shareDoc.rootOption")}</option>
                  {(folders ?? []).map((f) => (
                    <option key={f.id} value={f.id}>📁 {f.name}</option>
                  ))}
                  <option value={NEW}>{t("chat.shareDoc.newFolderOption")}</option>
                </select>
              </label>

              {folderSel === NEW && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">{t("chat.shareDoc.newFolderName")}</span>
                  <input
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    maxLength={50}
                    className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                    placeholder={t("chat.shareDoc.newFolderPlaceholder")}
                  />
                </label>
              )}

              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">{t("chat.shareDoc.preview")}</span>
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-fg/80">
                  {markdown}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line bg-white px-4 py-1.5 text-sm transition hover:bg-surface"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className={cn(
              "rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-fg shadow-glass transition",
              "enabled:hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {submitting ? t("common.saving") : t("chat.shareDoc.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
