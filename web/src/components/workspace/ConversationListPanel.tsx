import { useEffect, useRef, useState, type RefObject } from "react";
import type { ConversationListItem } from "@/lib/api";
import { dialog } from "@/components/Dialog";
import { useAnchoredMenu } from "@/lib/useAnchoredMenu";
import { useT } from "@/i18n";

// 左栏「对话」模式的会话列表:顶部「＋ 新对话」+ 会话项(标题/飞书标记/置顶标 + 悬停 ⋯ 菜单)。
// ⋯ 菜单(仿 ChatGPT):重命名 / 置顶·取消置顶 / 删除。改名走行内编辑(input),删除走 dialog.confirm。
// 飞书会话是常驻入口,不提供 ⋯ 菜单(不可改名/置顶/删除)。
export function ConversationListPanel({
  items, activeId, onNew, onPick, onRename, onPin, onDelete, hasMore, loadingMore, onLoadMore,
}: {
  items: ConversationListItem[];
  activeId: string | null;
  onNew: () => void;
  onPick: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const t = useT();
  // 行内重命名:editingId 为正在编辑的会话 id,draft 为输入草稿。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // ⋯ 菜单:menuId=菜单所属会话 id;anchorRef 指向被点击的 ⋯ 按钮(useAnchoredMenu 据此定位)。
  const [menuId, setMenuId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null); // 可变:点 ⋯ 时指向被点按钮;右键时指向整行
  const { menuRef, placement } = useAnchoredMenu(anchorRef as RefObject<HTMLElement>, menuId !== null, { align: "right" });

  // 菜单开着时:点菜单/按钮之外、或按 Esc → 关闭。
  useEffect(() => {
    if (menuId === null) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !anchorRef.current?.contains(t)) setMenuId(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setMenuId(null); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuId, menuRef]);

  // 列表刷新(后台轮完成/改名/置顶都会 loadConversations 重建 items)时关掉菜单 —— 否则
  // anchorRef 指向已卸载的旧 ⋯ 按钮,菜单会错位到左上角。
  useEffect(() => { setMenuId(null); }, [items]);

  function startRename(c: ConversationListItem) {
    setEditingId(c.id);
    setDraft(c.title ?? "");
  }
  function commitRename(id: string) {
    const t = draft.trim();
    setEditingId(null);
    if (t) onRename(id, t);
  }
  function confirmDelete(id: string) {
    void dialog
      .confirm(t("workspace.conv.confirmDelete"), { confirmText: t("common.delete"), danger: true })
      .then((ok) => { if (ok) onDelete(id); });
  }

  const menuConv = menuId !== null ? items.find((c) => c.id === menuId) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onNew}
        className="mx-2 mb-2 flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary bg-accent-soft text-sm font-medium text-primary transition hover:opacity-90"
      >
        {t("workspace.conv.new")}
      </button>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted">{t("workspace.conv.empty")}</p>
        ) : (
          <>
          {items.map((c) => {
            const title = c.title?.trim() || (c.isFeishu ? t("workspace.conv.feishuChat") : t("workspace.conv.newChat"));
            const on = c.id === activeId;
            const editing = editingId === c.id;
            const menuOpen = menuId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => { if (!editing) onPick(c.id); }}
                // 右键唤起操作菜单(重命名/置顶/删除),与点 ⋯ 一致。飞书会话无此菜单、编辑中不拦截原生右键。
                onContextMenu={(e) => {
                  if (editing || c.isFeishu) return;
                  e.preventDefault();
                  anchorRef.current = e.currentTarget;
                  setMenuId(c.id);
                }}
                className={`group flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm ${
                  on
                    ? "bg-accent-soft text-fg"
                    : c.isFeishu
                      // 飞书常驻置顶:略带蓝色调底色与普通会话区分(差异很轻,不抢眼)。
                      ? "bg-primary/[0.05] text-fg/80 hover:bg-primary/10"
                      : "text-fg/80 hover:bg-surface"
                }`}
              >
                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(c.id);
                      else if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={() => commitRename(c.id)}
                    maxLength={60}
                    aria-label={t("workspace.conv.titleLabel")}
                    className="min-w-0 flex-1 rounded border border-primary bg-white px-1.5 py-0.5 text-sm outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                )}
                {!editing && c.pinned && !c.isFeishu && (
                  <span className="shrink-0 text-muted" title={t("workspace.conv.pinned")}><PinIcon /></span>
                )}
                {!editing && (c.isFeishu ? (
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium leading-tight text-primary">{t("workspace.conv.feishu")}</span>
                ) : (
                  <button
                    type="button"
                    aria-label={t("workspace.more")}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    title={t("workspace.more")}
                    onClick={(e) => {
                      e.stopPropagation();
                      anchorRef.current = e.currentTarget;
                      setMenuId(menuOpen ? null : c.id);
                    }}
                    className={`shrink-0 rounded p-0.5 text-muted hover:bg-black/5 hover:text-fg ${menuOpen ? "flex" : "hidden group-hover:flex"}`}
                  >
                    <MoreIcon />
                  </button>
                ))}
              </div>
            );
          })}
          {hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="mx-1 mb-1 mt-0.5 h-8 shrink-0 rounded-lg text-xs text-muted transition hover:bg-surface disabled:opacity-60"
            >
              {loadingMore ? t("common.loading") : t("workspace.conv.loadMore")}
            </button>
          )}
          </>
        )}
      </nav>

      {/* ⋯ 菜单:重命名 / 置顶·取消置顶 / 删除。锚定到被点的 ⋯ 按钮,右对齐;首帧定位前隐藏防闪。 */}
      {menuConv && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 w-40 overflow-auto rounded-xl border border-line bg-white py-1 shadow-glassLg"
          style={{
            visibility: placement ? "visible" : "hidden",
            top: placement?.top, left: placement?.left, maxHeight: placement?.maxHeight,
          }}
        >
          <MenuRow icon={<RenameIcon />} label={t("workspace.rename")} onClick={() => { setMenuId(null); startRename(menuConv); }} />
          <MenuRow icon={<PinIcon />} label={menuConv.pinned ? t("workspace.unpin") : t("workspace.pin")} onClick={() => { setMenuId(null); onPin(menuConv.id, !menuConv.pinned); }} />
          <div className="my-1 border-t border-line" />
          <MenuRow icon={<TrashIcon />} label={t("common.delete")} danger onClick={() => { setMenuId(null); confirmDelete(menuConv.id); }} />
        </div>
      )}
    </div>
  );
}

function MenuRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition ${
        danger ? "text-rose-600 hover:bg-rose-50 hover:text-rose-700" : "text-fg/85 hover:bg-surface hover:text-primary"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

const ICON = "h-3.5 w-3.5";
function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}
function RenameIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
