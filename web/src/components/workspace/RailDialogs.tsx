import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useAnchoredMenu } from "@/lib/useAnchoredMenu";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { cn } from "@/lib/cn";
import { useUnsavedGuard } from "@/stores/unsavedGuard";

// Creating / importing a doc navigates into its editor, leaving whatever
// the user was editing. If that editor has unsaved changes, confirm first
// (and clear the dirty flag on confirm) — mirrors the rail-link guard in
// WorkspaceLeftRail so EVERY "leave the editor" path is covered.
//
// Uses the project's styled dialog.confirm (async) over native
// window.confirm so it matches the rail-link guard and the rest of the
// app's dialogs. Both call sites already run inside async flows that
// navigate imperatively afterward, so awaiting the prompt is safe.
async function confirmLeaveIfDirty(): Promise<boolean> {
  const { dirty, setDirty } = useUnsavedGuard.getState();
  if (!dirty) return true;
  const ok = await dialog.confirm("有未保存的修改，确定离开？未保存的内容将丢失。", {
    confirmText: "离开",
    danger: true,
  });
  if (!ok) return false;
  setDirty(false);
  return true;
}

// =============================================================
// AddPopover — fired by the + button on Role / Folder rows.
// Three options: 新建目录 / 新建文档 / 导入文档.
// When the trigger is a Role row, all 3 options are shown.
// When the trigger is a (depth-1) Folder row, we skip "新建目录" because
// folders cannot nest (the sub.png spec caps content at 2 levels).
// =============================================================

export type AddTarget =
  | { kind: "role"; roleId: string }
  // depth 0 = top-level folder (can host subfolders); depth 1 = subfolder (cannot).
  | { kind: "folder"; roleId: string; folderId: string; depth: 0 | 1 };

// One "create" action shared by the + popover and the right-click context menu.
export interface AddActionItem {
  key: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  /** Opens the matching dialog (or creates a doc immediately). */
  run: () => void;
}

// Owns the「新建目录 / 新建文档 / 导入文档」dialogs + handlers for ONE row, so
// both the + popover AND the row's right-click context menu can trigger the same
// actions against the same dialog instances. The row renders `dialogs` once and
// hands `items` to whichever menu surfaces them.
export function useAddActions(target: AddTarget, onCreated: () => void): {
  items: AddActionItem[];
  dialogs: React.ReactNode;
} {
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFeishuOpen, setImportFeishuOpen] = useState(false);
  const nav = useNavigate();

  async function createDocImmediate() {
    if (!(await confirmLeaveIfDirty())) return;
    try {
      const created = await api.articles.create({
        roleId: target.roleId,
        folderId: target.kind === "folder" ? target.folderId : null,
        // Send empty title — the server normalizes "" to the "未命名文档"
        // sentinel, which the editor shows as a placeholder hint.
        title: "",
        contentMarkdown: "",
      });
      onCreated();
      // New doc immediately routes to its editor.
      nav(`/d/${created.article.id}/edit`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // 「新建目录」shows on a role row (top-level folder) and on a TOP-LEVEL folder
  // row (creates a subfolder). Subfolder rows (depth 1) don't — depth caps at 2.
  const showCreateFolder = target.kind === "role" || (target.kind === "folder" && target.depth === 0);
  const items: AddActionItem[] = [
    ...(showCreateFolder
      ? [{
          key: "folder",
          icon: ICON_FOLDER,
          title: "新建目录",
          desc: target.kind === "folder" ? "在此目录内新建子目录" : "在该角色下新建目录",
          run: () => setCreateFolderOpen(true),
        }]
      : []),
    {
      key: "doc",
      icon: ICON_DOC,
      title: "新建文档",
      desc: target.kind === "folder" ? "在此目录内新建一篇文档" : "直接在该角色下新建一篇文档",
      run: () => { void createDocImmediate(); },
    },
    {
      key: "import",
      icon: ICON_IMPORT,
      title: "导入文档",
      desc: `将 .md 文件导入${target.kind === "folder" ? "此目录" : "该角色"}`,
      run: () => setImportOpen(true),
    },
    {
      key: "import-feishu",
      icon: ICON_IMPORT,
      title: "同步飞书文档",
      desc: `粘贴飞书 docx/wiki 链接导入${target.kind === "folder" ? "此目录" : "该角色"}`,
      run: () => setImportFeishuOpen(true),
    },
  ];

  // Dialogs render unconditionally (NOT gated by any menu's open state) so a
  // menu closing can never unmount them mid-interaction.
  const dialogs = (
    <>
      <CreateFolderDialog
        open={createFolderOpen}
        roleId={target.roleId}
        parentId={target.kind === "folder" ? target.folderId : null}
        onOpenChange={setCreateFolderOpen}
        onCreated={onCreated}
      />
      <ImportMdDialog
        open={importOpen}
        target={target}
        onOpenChange={setImportOpen}
        onImported={(id) => {
          setImportOpen(false);
          onCreated();
          // 去状态后文档无草稿/发布之分:统一进文档页(看即可改)。
          void confirmLeaveIfDirty().then((ok) => { if (ok) nav(`/d/${id}`); });
        }}
      />
      <ImportFeishuDialog
        open={importFeishuOpen}
        target={target}
        onOpenChange={setImportFeishuOpen}
        onImported={(id) => {
          setImportFeishuOpen(false);
          onCreated();
          void confirmLeaveIfDirty().then((ok) => { if (ok) nav(`/d/${id}/edit`); });
        }}
      />
    </>
  );

  return { items, dialogs };
}

interface AddPopoverProps {
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  items: AddActionItem[];
  onClose: () => void;
}

// Thin popover anchored to the + button. Renders the add items from
// useAddActions; the dialogs themselves live in the row (via the hook).
export function AddPopover({ anchorRef, open, items, onClose }: AddPopoverProps) {
  // 视口内锚定 + 实测高度翻转/限高:靠近侧边栏底部时不再被截断。
  const { menuRef, placement } = useAnchoredMenu(anchorRef, open, { align: "left" });

  // Close-on-outside-click. The trigger button is excluded so a click
  // on it re-toggles the popover instead of double-closing it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const node = menuRef.current;
      const anchor = anchorRef.current;
      if (!node) return;
      if (node.contains(e.target as Node)) return;
      if (anchor && anchor.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, anchorRef, onClose, menuRef]);

  if (!open) return null;
  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 w-72 overflow-y-auto rounded-xl border border-line bg-white shadow-glassLg"
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        maxHeight: placement?.maxHeight,
        // 定位算出前先隐藏,避免首帧闪在 (0,0)。
        visibility: placement ? "visible" : "hidden",
      }}
    >
      <div className="p-1.5">
        {items.map((it) => (
          <AddOption
            key={it.key}
            icon={it.icon}
            title={it.title}
            desc={it.desc}
            onClick={() => { onClose(); it.run(); }}
          />
        ))}
      </div>
    </div>
  );
}

function AddOption({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/opt flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition hover:bg-blue-50"
    >
      {/* NAMED group (`group/opt`) so hover is scoped to THIS option only.
          A plain `group-hover:` would also fire from the role row's ancestor
          `group` (the popover renders inside it), turning EVERY option violet
          while the row is hovered. Neutral at rest; only the hovered option
          lights up violet (icon + row bg + title). */}
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-muted transition-colors group-hover/opt:bg-blue-100 group-hover/opt:text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg transition-colors group-hover/opt:text-primary">{title}</span>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </button>
  );
}

// =============================================================
// CreateFolderDialog — name input + submit. New folder lands
// under the chosen role, becomes immediately visible in the tree.
// =============================================================
function CreateFolderDialog({
  open,
  roleId,
  parentId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  roleId: string;
  // null = create a top-level folder; a folder id = create a subfolder under it.
  parentId: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setName(""); }, [open]);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.folders.create({
        name: name.trim(),
        roleId,
        parentId,
        // Folders are public containers — no public/private flag. Per-doc
        // privacy is the draft lifecycle (drafts are author-only).
        visibility: "public",
        description: null,
      });
      onCreated();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新建目录</DialogTitle>
        </DialogHeader>
        <div className="mt-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="目录名称"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button size="sm" disabled={!name.trim() || busy} onClick={submit}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// ImportMdDialog — file picker + title preview + submit. Title is
// editable. Server validates .md extension; we also gate
// the file picker to .md client-side.
// =============================================================
function ImportMdDialog({
  open,
  target,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  target: AddTarget;
  onOpenChange: (open: boolean) => void;
  onImported: (newId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 命中同名时进入"冲突选择"步骤(覆盖 / 改名 / 返回)。
  const [conflict, setConflict] = useState<{ existingId: string; title: string } | null>(null);

  useEffect(() => {
    if (open) { setFile(null); setTitle(""); setDragOver(false); setConflict(null); }
  }, [open]);

  // Accept a picked/dropped file: gate to .md, default the title to its stem.
  function pickFile(f: File | null) {
    if (!f) return;
    if (!/\.md$/i.test(f.name)) { toast.error("仅支持 .md 文件"); return; }
    setFile(f);
    setTitle(f.name.replace(/\.md$/i, ""));
    setConflict(null); // 重新选文件 → 清掉旧的冲突态
  }
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    pickFile(e.target.files?.[0] ?? null);
  }

  // mode 省略 = 首次提交(命中同名则进冲突步骤);overwrite/rename = 用户已选。
  async function submit(mode?: "overwrite" | "rename") {
    if (!file || !title.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.articles.importMd({
        roleId: target.roleId,
        folderId: target.kind === "folder" ? target.folderId : null,
        title: title.trim(),
        file,
        onConflict: mode,
      });
      if ("conflict" in r) {
        setConflict(r.conflict);
        return;
      }
      toast.success(r.overwritten ? "已覆盖导入(原内容已存入历史版本)" : "导入成功");
      onImported(r.article.id);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (conflict) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>该位置已存在同名文档</DialogTitle>
            <p className="mt-1 text-xs text-muted">
              《{conflict.title}》已存在,请选择处理方式:
            </p>
          </DialogHeader>
          <div className="mt-3 space-y-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit("overwrite")}
              className="w-full rounded-xl border border-line px-4 py-3 text-left transition hover:border-primary/50 hover:bg-blue-50/50 disabled:opacity-60"
            >
              <span className="block text-sm font-medium text-fg">覆盖导入</span>
              <span className="mt-0.5 block text-xs text-muted">
                用导入内容替换该文档;原内容存入历史版本(可回滚)。
              </span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit("rename")}
              className="w-full rounded-xl border border-line px-4 py-3 text-left transition hover:border-primary/50 hover:bg-blue-50/50 disabled:opacity-60"
            >
              <span className="block text-sm font-medium text-fg">改名导入</span>
              <span className="mt-0.5 block text-xs text-muted">
                保留原文档,新文档自动改名(如「{conflict.title} (2)」)后导入。
              </span>
            </button>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConflict(null)}>
              {busy ? "导入中…" : "返回"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>导入文档</DialogTitle>
          <p className="mt-1 text-xs text-muted">仅支持 .md 文件,导入后即为可见文档。</p>
        </DialogHeader>
        <div className="mt-3 space-y-3">
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center transition ${
              dragOver
                ? "border-primary bg-blue-50/70"
                : "border-line bg-surface/40 hover:border-primary/50 hover:bg-blue-50/40"
            }`}
          >
            <input type="file" accept=".md,text/markdown" onChange={onFileChange} className="hidden" />
            {file ? (
              <div className="flex w-full items-center gap-3 text-left">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" /><path d="M9 13h6M9 17h4" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{file.name}</span>
                  <span className="block text-xs text-muted">{(file.size / 1024).toFixed(1)} KB · 点击或拖拽可重新选择</span>
                </span>
              </div>
            ) : (
              <>
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 text-primary">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
                  </svg>
                </span>
                <span className="text-sm font-medium text-fg/85">点击选择，或将 .md 文件拖到此处</span>
                <span className="text-xs text-muted">仅支持 Markdown（.md）文件</span>
              </>
            )}
          </label>
          <div>
            <label className="text-xs font-medium text-muted">文档标题</label>
            <Input
              value={title}
              onChange={(e) => { setTitle(e.target.value); setConflict(null); }}
              placeholder="文档标题"
              className="mt-1"
              disabled={!file}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button size="sm" disabled={!file || !title.trim() || busy} onClick={() => void submit()}>
            {busy ? "导入中…" : "导入"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// ImportFeishuDialog — paste a Feishu docx/wiki link → import as a
// document. The radio group (default 保留) decides what happens to blocks
// that can't be converted: keep as a placeholder note + source link,
// or drop them entirely.
// =============================================================
const UNSUPPORTED_OPTIONS = [
  {
    value: "placeholder",
    title: "保留不支持的内容",
    desc: "尽量转换为可编辑内容（可能有偏差）；仍无法转换的块保留占位说明并附原文链接",
  },
  {
    value: "drop",
    title: "丢弃不支持的内容",
    desc: "尽量转换为可编辑内容（可能有偏差）；仍无法转换的块直接丢弃，不保留占位",
  },
] as const;

function ImportFeishuDialog({
  open,
  target,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  target: AddTarget;
  onOpenChange: (open: boolean) => void;
  onImported: (newId: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"placeholder" | "drop">("placeholder");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setUrl(""); setMode("placeholder"); }
  }, [open]);

  async function submit() {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.articles.importFeishu({
        roleId: target.roleId,
        folderId: target.kind === "folder" ? target.folderId : null,
        url: url.trim(),
        unsupportedMode: mode,
      });
      const { report } = r;
      const bits = [`已导入,转换 ${report.converted} 块`];
      if (report.placeholderBlocks) bits.push(`${report.placeholderBlocks} 个不支持的块转为占位`);
      if (report.droppedBlocks) bits.push(`已丢弃 ${report.droppedBlocks} 个不支持的块`);
      if (report.warnings.length) bits.push(`${report.warnings.length} 处告警`);
      toast.success(bits.join("，"));
      onImported(r.article.id);
    } catch (err) {
      // The server returns a clear, actionable message per failure (missing
      // permission / not re-consented / no view access). Surface it via toast —
      // a nested confirm dialog over this modal can't receive clicks (the Radix
      // focus-trap eats them), which is why the old "去授权/取消" did nothing.
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>同步飞书文档</DialogTitle>
          <p className="mt-1 text-xs text-muted">粘贴你有查看权限的飞书 docx / 知识库 wiki 链接，导入后创建为文档。</p>
        </DialogHeader>
        <div className="mt-3 space-y-3">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://xxx.feishu.cn/docx/..."
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          <div className="space-y-2">
            {UNSUPPORTED_OPTIONS.map((opt) => {
              const checked = mode === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer gap-2.5 rounded-lg border p-2.5 transition ${
                    checked ? "border-primary bg-blue-50/70" : "border-line hover:bg-blue-50/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="feishu-unsupported"
                    value={opt.value}
                    checked={checked}
                    onChange={() => setMode(opt.value)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{opt.title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{opt.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button size="sm" disabled={!url.trim() || busy} onClick={submit}>
            {busy ? "导入中…" : "导入"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// RenameDialog — works for both folder and doc. Resource type
// determines which API to call.
// =============================================================
export function RenameDialog({
  open,
  kind,
  id,
  initialName,
  onOpenChange,
  onRenamed,
}: {
  open: boolean;
  kind: "folder" | "doc";
  id: string;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setName(initialName); }, [open, initialName]);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (kind === "folder") {
        await api.folders.update(id, { name: name.trim() });
      } else {
        await api.articles.update(id, { title: name.trim() });
      }
      onRenamed();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>重命名{kind === "folder" ? "目录" : "文档"}</DialogTitle>
        </DialogHeader>
        <div className="mt-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button size="sm" disabled={!name.trim() || busy} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// MoveDialog — pick a target folder OR role-direct for a doc.
// Lists all folders in the doc's role (no cross-role moves —
// keeps collaborator semantics intact).
// =============================================================
export function MoveDialog({
  open,
  docId,
  roleId,
  currentFolderId,
  folders,
  onOpenChange,
  onMoved,
}: {
  open: boolean;
  docId: string;
  roleId: string;
  currentFolderId: string | null;
  // depth (0 = top-level, 1 = subfolder) drives the indentation of subfolder rows.
  folders: { id: string; name: string; depth?: number }[];
  onOpenChange: (open: boolean) => void;
  onMoved: () => void;
}) {
  const [target, setTarget] = useState<string | null>(currentFolderId);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setTarget(currentFolderId); }, [open, currentFolderId]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await api.articles.move(docId, target);
      onMoved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>移动文档</DialogTitle>
          <p className="mt-1 text-xs text-muted">选择目标目录，或直接挂到角色下。</p>
        </DialogHeader>
        <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-line">
          <button
            type="button"
            onClick={() => setTarget(null)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-blue-50/60 hover:text-primary",
              target === null && "bg-accent-soft text-primary font-medium",
            )}
          >
            <span className="text-muted">📁</span>
            <span>角色根目录（直挂）</span>
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setTarget(f.id)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-blue-50/60 hover:text-primary",
                target === f.id && "bg-accent-soft text-primary font-medium",
              )}
              style={f.depth ? { paddingLeft: `${0.75 + f.depth * 1.25}rem` } : undefined}
            >
              <span className="text-muted">{f.depth ? "📁" : "📂"}</span>
              <span className="truncate">{f.name}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button size="sm" disabled={busy} onClick={submit}>
            {busy ? "移动中…" : "移动"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// DeleteFolderDialog — soft-delete a folder. The folder AND its
// documents move to the deleter's recycle bin together (the server now
// always cascades children with the folder); restoring the folder from
// the bin brings the docs back as a unit. A single confirm — the old
// "move children to role-direct vs delete" split no longer applies.
// =============================================================
export function DeleteFolderDialog({
  open,
  folderId,
  folderName,
  articleCount,
  subfolderCount,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  folderId: string;
  folderName: string;
  articleCount: number;
  subfolderCount: number;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await api.folders.delete(folderId);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>删除目录《{folderName}》</DialogTitle>
        </DialogHeader>
        {articleCount === 0 && subfolderCount === 0 ? (
          <p className="mt-3 text-sm text-muted">此目录为空。删除后会移到回收站，可在回收站还原。</p>
        ) : (
          <p className="mt-3 text-sm text-muted">
            此目录包含
            {subfolderCount > 0 && <> <span className="font-medium text-fg">{subfolderCount}</span> 个子目录</>}
            {articleCount > 0 && <>{subfolderCount > 0 ? "、" : " "}<span className="font-medium text-fg">{articleCount}</span> 篇文档{subfolderCount > 0 && "（含子目录中的文档）"}</>}
            。删除后会和其中内容一起移到回收站，你可以在回收站整体还原或永久删除。
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button variant="danger" size="sm" disabled={busy} onClick={doDelete}>
            {busy ? "删除中…" : "删除"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// DeleteDocDialog — simple confirm for doc delete.
// =============================================================
export function DeleteDocDialog({
  open,
  docId,
  docTitle,
  roleId,
  folderId,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  docId: string;
  docTitle: string;
  // Where the doc lives — used to send the reader back to the parent (its
  // folder, or the role view for a role-direct doc) when the deleted doc is
  // the one currently open on the right pane.
  roleId: string;
  folderId: string | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const nav = useNavigate();
  const loc = useLocation();
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await api.articles.delete(docId);
      onDeleted();
      onOpenChange(false);
      // If the right pane is showing the just-deleted doc (/d/:id or its
      // editor), leaving it there strands the reader on a 404. Send them to
      // the parent folder, or the role view for a role-direct doc. Deleting
      // some OTHER doc from the tree must NOT yank the reader off what they're
      // viewing — hence the gate on the current path matching the deleted doc.
      if (loc.pathname === `/d/${docId}` || loc.pathname === `/d/${docId}/edit`) {
        nav(folderId ? `/f/${folderId}` : `/r/${roleId}`, { replace: true });
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>删除文档《{docTitle}》</DialogTitle>
        </DialogHeader>
        <p className="mt-3 text-sm text-muted">删除后会移到回收站，可在回收站还原。确认删除？</p>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">取消</Button>
          </DialogClose>
          <Button variant="danger" size="sm" disabled={busy} onClick={doDelete}>
            {busy ? "删除中…" : "删除"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Inline icons for AddPopover options ----------
const ICON_FOLDER = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const ICON_DOC = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="15" y2="17" />
  </svg>
);
const ICON_IMPORT = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
