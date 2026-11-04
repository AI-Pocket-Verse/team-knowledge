import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { resolveRoleColor } from "@/lib/roleColors";
import { fmtRelativeTime } from "@/lib/relativeTime";

// 搜索结果 / 最近浏览共用的「富行」:文档图标(按角色色)+ 标题 + 一行副标题
// 「知识库:角色›目录 ·(你在 X 打开过 ·){修改人} 在 X 修改过」。其中「你在 X 打开过」
// 仅最近浏览行有(传 lastViewedAt 才出)。点行写历史/跳转由调用方在 onNavigate 处理。
//
// 搜索结果列表里行可被键盘上下选中:传 optionId 即渲染为 role="option"(配合输入框的
// combobox + aria-activedescendant),active 时高亮并滚动进可视区。最近浏览/历史不传
// optionId,退化为普通链接行(仅 hover 高亮)。
export interface DocRowData {
  id: string;
  title: string;
  roleName: string;
  roleColor: string | null;
  folderName: string | null;
  updatedAt?: string;
  editorName?: string | null;
  /** 仅「最近浏览」行有:当前用户最近一次打开该文档的时间(ISO)。 */
  lastViewedAt?: string;
}

export function DocResultRow({
  doc,
  onNavigate,
  active = false,
  optionId,
  onMouseEnter,
}: {
  doc: DocRowData;
  onNavigate: () => void;
  active?: boolean;
  /** 传入即把行标记为 listbox 的 option(键盘可选中);省略则为普通行。 */
  optionId?: string;
  onMouseEnter?: () => void;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const { from, to } = resolveRoleColor(doc.roleColor);

  // 键盘选中时把该行滚进可视区(block:nearest 不抢占整页滚动)。可选链调用:
  // jsdom 等环境没有 scrollIntoView 时静默跳过,不抛错。
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const sub: string[] = [];
  sub.push(`知识库：${doc.folderName ? `${doc.roleName}›${doc.folderName}` : doc.roleName}`);
  if (doc.lastViewedAt) sub.push(`你在 ${fmtRelativeTime(doc.lastViewedAt)}打开过`);
  if (doc.editorName && doc.updatedAt) sub.push(`${doc.editorName} 在 ${fmtRelativeTime(doc.updatedAt)}修改过`);
  else if (doc.updatedAt) sub.push(`${fmtRelativeTime(doc.updatedAt)}更新`);

  return (
    <Link
      ref={ref}
      to={`/d/${doc.id}`}
      onClick={onNavigate}
      onMouseEnter={onMouseEnter}
      id={optionId}
      role={optionId ? "option" : undefined}
      aria-selected={optionId ? active : undefined}
      className={`flex items-start gap-3 rounded-lg px-3 py-2 transition ${active ? "bg-blue-100" : "hover:bg-blue-50/60"}`}
    >
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `${from}1f`, color: to }}
        aria-hidden
      >
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{doc.title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">{sub.join(" · ")}</span>
      </span>
    </Link>
  );
}
