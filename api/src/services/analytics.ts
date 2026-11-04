// Pure aggregation helpers for the admin analytics dashboard. Kept free of
// Prisma / IO so they can be unit-tested in isolation; the route
// (routes/admin-analytics.ts) feeds them rows it has already queried.
import type { AnalyticsComposition, AnalyticsTrends } from "@team-knowledge/shared";
import type { ActivityEvent } from "./activity.js";
import { beijingDayKey } from "../utils/day.js";

// The 8 content-event series of the trend chart (activeUsers + dayLabels are
// assembled separately by the route — they don't come from ActivityEvent).
type TrendKey = "docCreate" | "docEdit" | "comment" | "like" | "bookmark" | "upload" | "chat" | "meeting";
export type ContentTrends = Pick<AnalyticsTrends, TrendKey>;

// ActivityEvent.type → trend series key. Any unknown type is ignored.
const TYPE_TO_KEY: Record<string, TrendKey> = {
  doc_create: "docCreate",
  doc_edit: "docEdit",
  // Finer-grained doc events (restore / archive) are still "edits" for the
  // trend chart — fold them into docEdit so no new line is needed; the live
  // feed shows them with their own labels.
  doc_restore: "docEdit",
  doc_archive: "docEdit",
  doc_unarchive: "docEdit",
  comment: "comment",
  like: "like",
  bookmark: "bookmark",
  upload: "upload",
  chat: "chat",
  meeting: "meeting",
};

/** Bucket activity events into per-day counts per series, aligned to dayKeys
 *  (oldest → newest). Events whose Beijing day falls outside dayKeys are dropped. */
export function bucketTrends(events: ActivityEvent[], dayKeys: string[]): ContentTrends {
  const idx = new Map(dayKeys.map((k, i) => [k, i]));
  const blank = (): number[] => new Array(dayKeys.length).fill(0);
  const out: ContentTrends = {
    docCreate: blank(), docEdit: blank(), comment: blank(),
    like: blank(), bookmark: blank(), upload: blank(),
    chat: blank(), meeting: blank(),
  };
  for (const e of events) {
    const key = TYPE_TO_KEY[e.type];
    if (!key) continue;
    const i = idx.get(beijingDayKey(e.at));
    if (i === undefined) continue;
    out[key][i] += 1;
  }
  return out;
}

// 热门文档综合热度权重(窗口内)。浏览是「打开过」的弱信号(每人计一次),
// 互动是「认可/投入」的强信号,故互动权重高于浏览。与贡献度权重的相对关系一致。
export const HOTDOC_WEIGHTS = { viewer: 1, like: 2, comment: 3, bookmark: 2 } as const;

export interface HotDocScore {
  articleId: string; score: number;
  viewers: number; likes: number; comments: number; bookmarks: number;
}

/** 综合窗口内的「独立浏览人数 + 点赞 + 评论 + 收藏」为每篇文档打热度分,倒序返回。
 *  各来源已由调用方按窗口 groupBy 过滤(浏览按 lastViewedAt,互动按 createdAt),
 *  这里只做纯合并打分,便于单测。 */
export function scoreHotDocs(sources: {
  viewers: { articleId: string; count: number }[];
  likes: { articleId: string; count: number }[];
  comments: { articleId: string; count: number }[];
  bookmarks: { articleId: string; count: number }[];
}): HotDocScore[] {
  const m = new Map<string, { viewers: number; likes: number; comments: number; bookmarks: number }>();
  const cell = (id: string) => {
    let v = m.get(id);
    if (!v) { v = { viewers: 0, likes: 0, comments: 0, bookmarks: 0 }; m.set(id, v); }
    return v;
  };
  for (const r of sources.viewers) cell(r.articleId).viewers += r.count;
  for (const r of sources.likes) cell(r.articleId).likes += r.count;
  for (const r of sources.comments) cell(r.articleId).comments += r.count;
  for (const r of sources.bookmarks) cell(r.articleId).bookmarks += r.count;
  return [...m.entries()]
    .map(([articleId, c]) => ({
      articleId, ...c,
      score:
        c.viewers * HOTDOC_WEIGHTS.viewer +
        c.likes * HOTDOC_WEIGHTS.like +
        c.comments * HOTDOC_WEIGHTS.comment +
        c.bookmarks * HOTDOC_WEIGHTS.bookmark,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Collapse Upload.mimeType group-counts into image / document / other buckets.
 *  Always returns all three keys (count 0 when empty) so the pie has a stable shape. */
export function bucketUploadTypes(
  rows: { mimeType: string; count: number }[],
): AnalyticsComposition["byUpload"] {
  let image = 0, document = 0, other = 0;
  for (const r of rows) {
    const m = (r.mimeType || "").toLowerCase();
    if (m.startsWith("image/")) {
      image += r.count;
    } else if (
      m.startsWith("text/") ||
      m === "application/pdf" ||
      m === "application/json" ||
      m === "application/zip" ||
      m.includes("msword") ||
      m.includes("word") ||
      m.includes("excel") ||
      m.includes("spreadsheet") ||
      m.includes("powerpoint") ||
      m.includes("presentation") ||
      m.includes("officedocument") ||
      m.includes("opendocument")
    ) {
      document += r.count;
    } else {
      other += r.count;
    }
  }
  return [
    { key: "image", count: image },
    { key: "document", count: document },
    { key: "other", count: other },
  ];
}
