import { useEffect, useRef, useState } from "react";
import type { AdminActivityPageResponse, AdminActivityType } from "@team-knowledge/shared";
import { DelayedLoader } from "@/components/DelayedLoader";
import { fmtRelativeTime } from "@/lib/relativeTime";
import { getAssistantName } from "@/lib/assistantName";

export const ACTIVITY_LABEL: Record<AdminActivityType, string> = {
  doc_create: "新建文档",
  doc_edit: "编辑文档",
  doc_restore: "回滚版本",
  doc_archive: "归档文档",
  doc_unarchive: "取消归档",
  comment: "评论",
  like: "点赞",
  bookmark: "收藏",
  upload: "上传文件",
  meeting: "发起会议",
  get chat() { return `向 ${getAssistantName()} 提问`; },
  doc_fix: "处理体检问题",
  comment_like: "点赞评论",
  automation_create: "创建自动化",
  meeting_comment: "会议发言",
  folder_create: "新建目录",
  editor_grant: "加协作者",
};

// Reusable paginated activity feed (10/page) shared by the admin dashboard
// (global + per-user drawer) and the profile 动态 tab. The caller supplies a
// `fetchPage(page)` thunk; we keep it in a ref so its identity churning per
// render never re-triggers the fetch. `resetKey` (e.g. a userId) resets to
// page 1 and refetches when the underlying subject changes.
export function ActivityFeed({
  fetchPage,
  resetKey = "",
  hideUser,
  emptyHint = "暂无动态",
}: {
  fetchPage: (page: number) => Promise<AdminActivityPageResponse>;
  resetKey?: string;
  hideUser?: boolean;
  emptyHint?: string;
}) {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminActivityPageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [resetKey]);
  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchRef.current(page)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [page, resetKey]);

  if (err) return <div className="px-4 py-6 text-sm text-rose-600">{err}</div>;
  if (!data) return <div className="px-4 py-6"><DelayedLoader /></div>;
  if (data.total === 0) return <div className="px-4 py-8 text-center text-sm text-muted">{emptyHint}</div>;

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <>
      <ul className="divide-y divide-line/60">
        {data.items.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-4 py-2.5 text-sm transition hover:bg-surface">
            {!hideUser && <span className="shrink-0 font-medium text-fg">{r.userName}</span>}
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-primary">{ACTIVITY_LABEL[r.type]}</span>
            {r.title && <span className="min-w-0 truncate text-muted">{r.title}</span>}
            <span className="ml-auto shrink-0 text-xs text-muted/70 tabular-nums">{fmtRelativeTime(r.at)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
        <span>共 {data.total} 条</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg border border-line bg-white px-2 py-1 transition enabled:hover:bg-surface disabled:opacity-40"
          >
            上一页
          </button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <button
            type="button"
            disabled={!data.hasMore}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-line bg-white px-2 py-1 transition enabled:hover:bg-surface disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </>
  );
}
