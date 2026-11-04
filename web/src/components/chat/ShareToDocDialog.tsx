import { useEffect, useMemo, useState } from "react";
import type { ChatMessageRow, WorkspaceRole, FolderRow } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { cn } from "@/lib/cn";
import { useAuth } from "@/stores/auth";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { CHAT_CARD_USER_LABEL, chatCardAssistantLabel } from "./chatCardLabels";
import { getAssistantName } from "@/lib/assistantName";

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
  const blocks: string[] = [`*摘自 ${getAssistantName()} 对话*`, ""];
  for (const m of messages) {
    const label = m.role === "user" ? CHAT_CARD_USER_LABEL : chatCardAssistantLabel();
    const images = m.images ?? [];
    const hasContent = m.content.trim().length > 0;
    blocks.push(`> **${label}**`, ">");
    // Attached images first (matches the chat UI's 图在上、文字在下). Each is a
    // quoted markdown image so it stays inside this card's single blockquote;
    // urls are the raw /uploads/<file> the row carries (stored as-is in the doc).
    for (const url of images) blocks.push(`> ![图片](${url})`);
    if (images.length && hasContent) blocks.push(">");
    // Show body text when there is any — or the placeholder only when the card
    // would otherwise be empty (no text AND no images).
    if (hasContent || images.length === 0) {
      const body = m.content.trim() || (m.role === "user" ? "_（空）_" : "_（无内容）_");
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
  const isAdmin = useAuth((s) => Boolean(s.user?.isAdmin));
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);

  const [title, setTitle] = useState(`${getAssistantName()} 对话摘录`);
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
      .catch((e) => { if (alive) { setRoles([]); toast.error(e instanceof ApiError ? e.message : "加载角色失败"); } });
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
      toast.success("已保存为文档");
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
          <div className="text-base font-semibold text-fg">分享到文档</div>
          <div className="text-xs text-muted">已选 {messages.length} 条</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {noWritableRole ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              你还没有可写入的角色，暂时无法保存对话。请联系管理员为你分配角色。
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">文档标题</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={255}
                  className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                  placeholder="给这份摘录起个标题"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">保存到角色</span>
                <select
                  value={roleSel}
                  onChange={(e) => setRoleSel(e.target.value)}
                  disabled={roles === null}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  {roles === null && <option value="">加载中…</option>}
                  {(roles ?? []).map((r) => (
                    <option key={r.id} value={r.id}>👤 {r.name}</option>
                  ))}
                  {isAdmin && <option value={NEW}>➕ 新建角色…</option>}
                </select>
              </label>

              {roleSel === NEW && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">新角色名称</span>
                  <input
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    maxLength={50}
                    className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                    placeholder="例如：市场部"
                  />
                </label>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">保存到目录</span>
                <select
                  value={folderSel}
                  onChange={(e) => setFolderSel(e.target.value)}
                  disabled={loadingFolders}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value={ROOT}>📂 角色根目录（不放入目录）</option>
                  {(folders ?? []).map((f) => (
                    <option key={f.id} value={f.id}>📁 {f.name}</option>
                  ))}
                  <option value={NEW}>➕ 新建目录…</option>
                </select>
              </label>

              {folderSel === NEW && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">新目录名称</span>
                  <input
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    maxLength={50}
                    className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                    placeholder="例如：会议记录"
                  />
                </label>
              )}

              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">预览</span>
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
            取消
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
            {submitting ? "保存中…" : "归档为文档"}
          </button>
        </div>
      </div>
    </div>
  );
}
