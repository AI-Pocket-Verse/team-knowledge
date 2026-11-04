import type { FolderRow, SlimDoc } from "@team-knowledge/shared";

// AI 校验「待优化」红色感叹号:文档有问题且当前用户可编辑才显示;父目录/角色按子孙聚合。
// 单一来源,供边栏(WorkspaceLeftRail)与角色/目录右侧列表页(RolePage/ArticleListPage/
// ArticleTimeFeed/WorkspaceFolderListItem)统一使用,样式一致。

export function docHasReviewBadge(d: { reviewStatus?: string; permissions: { canEdit: boolean } }): boolean {
  return d.reviewStatus === "issues" && d.permissions.canEdit;
}

export function folderHasReviewIssues(f: FolderRow): boolean {
  return f.articles.some(docHasReviewBadge) || f.children.some(folderHasReviewIssues);
}

export function treeHasReviewIssues(tree: { folders: FolderRow[]; directArticles: SlimDoc[] }): boolean {
  return tree.directArticles.some(docHasReviewBadge) || tree.folders.some(folderHasReviewIssues);
}

/** 红色感叹号徽标。紧挨文本(ml 5px),尺寸偏小(14px 圆点)。 */
export function ReviewBadge({ title }: { title: string }) {
  return (
    <span
      title={title}
      aria-label="待优化"
      className="ml-[5px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold leading-none text-white"
    >
      !
    </span>
  );
}
