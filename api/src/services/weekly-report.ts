// 知识库周报:聚合 + 持久化 + 定时调度。
//
// 数据来源复用 loadActivityEvents(8 类内容写入事件)+ ArticleView(查看)。所有
// 时间按【北京自然周(周一–周日)】分桶(见 utils/beijingWeek)。每周一 00:00
// 北京定时生成「上一个完整周」快照,落 WeeklyReport 表(JSON snapshot,weekKey 唯一
// → 幂等)。不引入 @team-knowledge/db-kit,以便随路由进入 buildServer 时仍可被 vitest。
import type { FastifyBaseLogger } from "fastify";
import type {
  AdminActivityType,
  WeeklyReportSnapshot,
  WeeklyReportUserRow,
  WeeklyReportTrendPoint,
  WeeklyReportCompositionSlice,
  WeeklyReportLiveItem,
  WeeklyReportUserDimension,
  WeeklyReportListItem,
  WeeklyReportDetailResponse,
} from "@team-knowledge/shared";
import { prisma } from "../db.js";
import { loadActivityEvents } from "./activity.js";
import { eventWeight, receivedRecognition, RECEIVED_WEEKLY_CAP } from "./contribution.js";
import { isRestoring } from "./backup.js";
import { notifyAdminsOfWeeklyReport } from "../utils/notify/adminAlert.js";
import {
  type BeijingWeek,
  beijingDayKey,
  beijingWeekDayKeys,
  beijingWeekLabel,
  beijingWeekOf,
  previousBeijingWeek,
  msUntilNextBeijingMonday,
} from "../utils/beijingWeek.js";
import { ASSISTANT_NAME } from "../utils/assistant.js";
import { L, appLang } from "../utils/lang.js";

type ReportType = AdminActivityType | "view";

// 贡献度权重已抽到 services/contribution.ts(周报与看板排行共用同一口径)。

// type → 概览/明细里的归类。所有「版本类」事件(含一键优化 doc_fix)归为「修改文档」,
// 不新增图表切片。
function isDocEdit(t: ReportType): boolean {
  return t === "doc_edit" || t === "doc_fix" || t === "doc_restore" || t === "doc_archive" || t === "doc_unarchive";
}

// 英文标签(与 TYPE_LABEL 一一对应)。
const TYPE_LABEL_EN: Record<string, string> = {
  doc_create: "Created a doc",
  doc_edit: "Edited a doc",
  doc_restore: "Restored a doc",
  doc_archive: "Archived a doc",
  doc_unarchive: "Unarchived a doc",
  comment: "Comment",
  like: "Like",
  bookmark: "Bookmark",
  upload: "Upload",
  meeting: "Meeting",
  chat: `Asked ${ASSISTANT_NAME}`,
  view: "Viewed a doc",
  doc_fix: "Fixed check issues",
  comment_like: "Liked a comment",
  automation_create: "Created an automation",
  meeting_comment: "Meeting remark",
  folder_create: "Created a folder",
  editor_grant: "Added a collaborator",
};

// 中文标签(实时动态 + 构成饼图)。
const TYPE_LABEL: Record<string, string> = {
  doc_create: "新建文档",
  doc_edit: "修改文档",
  doc_restore: "回滚文档",
  doc_archive: "归档文档",
  doc_unarchive: "取消归档",
  comment: "评论",
  like: "点赞",
  bookmark: "收藏",
  upload: "上传",
  meeting: "会议",
  chat: `向 ${ASSISTANT_NAME} 提问`,
  view: "查看文档",
  doc_fix: "处理体检问题",
  comment_like: "点赞评论",
  automation_create: "创建自动化",
  meeting_comment: "会议发言",
  folder_create: "新建目录",
  editor_grant: "加协作者",
};

interface RptEvent {
  uid: string;
  at: Date;
  type: ReportType;
  title: string | null;
}

// 事件跨度启发式估算在线时长(分钟):同一用户相邻事件间隔 <30 分钟算连续在线,
// 累加;每个会话另加 2 分钟停留,避免孤立事件计 0。纯估算。
const IDLE_GAP_MS = 30 * 60 * 1000;
const SESSION_DWELL_MS = 2 * 60 * 1000;
function durationMin(timestamps: number[]): number {
  if (timestamps.length === 0) return 0;
  const t = [...timestamps].sort((a, b) => a - b);
  let total = SESSION_DWELL_MS; // 首个会话
  for (let i = 1; i < t.length; i++) {
    const gap = t[i] - t[i - 1];
    total += gap < IDLE_GAP_MS ? gap : SESSION_DWELL_MS; // 同会话累加间隔,跨会话另起停留
  }
  return Math.round(total / 60000);
}

// 快照会长期落库、周报页还可能放开给全员，所以会议 / 自动化 / 上传这几类事件不存标题：
// 会议之后可能被改成私密，自动化名与上传原名本就是个人私有信息。只影响实时动态里的文字，
// 图表与汇总数字不受影响。
const UNTITLED_TYPES: ReadonlySet<string> = new Set(["meeting", "meeting_comment", "automation_create", "upload"]);
function stripPrivateTitles(items: WeeklyReportLiveItem[]): WeeklyReportLiveItem[] {
  return items.map((i) => (UNTITLED_TYPES.has(i.type) && i.title !== null ? { ...i, title: null } : i));
}

// 拉取本周(北京周)全部事件:活动事件 + 查看事件,过滤到 [weekStart, weekEnd)。
async function loadWeekEvents(week: BeijingWeek): Promise<RptEvent[]> {
  const { weekStart, weekEnd } = week;
  // take 给足够大,避免内部按源截断(本工具单周量级远不及上限)。
  const activity = (await loadActivityEvents(weekStart, undefined, 100000))
    .filter((e) => e.uid && e.at >= weekStart && e.at < weekEnd)
    .map((e) => ({ uid: e.uid as string, at: e.at, type: e.type as ReportType, title: e.title }));
  // 查看文档:ArticleView 为累计汇总(无单次时间戳),按「本周末次查看」近似为去重
  // 查看事件(每个 用户×文档 一条)。
  const views = await prisma.articleView.findMany({
    where: { lastViewedAt: { gte: weekStart, lt: weekEnd }, article: { deletedAt: null } },
    select: { userId: true, lastViewedAt: true, article: { select: { title: true } } },
  });
  const viewEvents: RptEvent[] = views.map((v) => ({
    uid: v.userId,
    at: v.lastViewedAt,
    type: "view",
    title: v.article?.title ?? null,
  }));
  return [...activity, ...viewEvents];
}

// 一段中文概览文字(详情页 + 飞书通知 + 导出共用)。
function buildSummary(
  weekLabel: string,
  o: WeeklyReportSnapshot["overview"],
  users: WeeklyReportUserRow[],
): string {
  const lang = appLang();
  if (o.activeUsers === 0) return L(lang, `本周（${weekLabel}）知识库暂无活动记录。`, `No knowledge base activity recorded this week (${weekLabel}).`);
  const hrs = (o.totalDurationMin / 60).toFixed(1);
  const top = users[0];
  if (lang === "en") {
    let e = `This week (${weekLabel}), ${o.activeUsers} ${o.activeUsers === 1 ? "member was" : "members were"} active, with about ${hrs} hours online in total. `;
    e += `Content: ${o.docCreate} ${o.docCreate === 1 ? "doc" : "docs"} created, ${o.docEdit} ${o.docEdit === 1 ? "edit" : "edits"}, ${o.chat} ${o.chat === 1 ? "question" : "questions"} to ${ASSISTANT_NAME}, `;
    e += `${o.comment} ${o.comment === 1 ? "comment" : "comments"}, ${o.like} ${o.like === 1 ? "like" : "likes"}, ${o.view} doc ${o.view === 1 ? "view" : "views"}`;
    if (o.meeting > 0) e += `, ${o.meeting} ${o.meeting === 1 ? "meeting" : "meetings"}`;
    e += ".";
    if (top) e += ` Top contributor: ${top.name} (${top.contribution} pts).`;
    return e;
  }
  let s = `本周（${weekLabel}）共有 ${o.activeUsers} 位成员活跃，累计在线约 ${hrs} 小时。`;
  s += `内容方面：新建文档 ${o.docCreate} 篇、修改 ${o.docEdit} 次，向 ${ASSISTANT_NAME} 提问 ${o.chat} 次，`;
  s += `评论 ${o.comment} 条、点赞 ${o.like} 次、查看文档 ${o.view} 次`;
  if (o.meeting > 0) s += `，会议 ${o.meeting} 场`;
  s += "。";
  if (top) s += `贡献度最高的是 ${top.name}（${top.contribution} 分）。`;
  return s;
}

// 把一周的事件聚合成完整快照。
export async function buildWeeklySnapshot(week: BeijingWeek): Promise<WeeklyReportSnapshot> {
  const events = await loadWeekEvents(week);
  const dayKeys = beijingWeekDayKeys(week);

  // ── 概览累计 ──
  const overview = {
    activeUsers: 0,
    totalDurationMin: 0,
    docCreate: 0,
    docEdit: 0,
    chat: 0,
    comment: 0,
    like: 0,
    view: 0,
    meeting: 0,
    bookmark: 0,
    upload: 0,
    totalOps: events.length,
  };

  // ── 趋势分桶(每个北京日一桶)──
  const dayIndex = new Map(dayKeys.map((k, i) => [k, i]));
  const trends: WeeklyReportTrendPoint[] = dayKeys.map((day) => ({
    day, docCreate: 0, docEdit: 0, comment: 0, like: 0, chat: 0, view: 0, activeUsers: 0,
  }));
  const dayActiveUsers: Array<Set<string>> = dayKeys.map(() => new Set());

  // ── 每用户累计(含每日趋势 + 全 9 类构成)──
  interface Acc {
    times: number[];
    days: Set<string>;
    daily: WeeklyReportTrendPoint[]; // 7 天,每用户(activeUsers 固定 0)
    docCreate: number; docEdit: number; chat: number; comment: number; like: number; view: number;
    bookmark: number; upload: number; meeting: number;
    contribution: number; ops: number;
  }
  const byUser = new Map<string, Acc>();
  const accOf = (uid: string): Acc => {
    let a = byUser.get(uid);
    if (!a) {
      a = {
        times: [], days: new Set(),
        daily: dayKeys.map((day) => ({ day, docCreate: 0, docEdit: 0, comment: 0, like: 0, chat: 0, view: 0, activeUsers: 0 })),
        docCreate: 0, docEdit: 0, chat: 0, comment: 0, like: 0, view: 0,
        bookmark: 0, upload: 0, meeting: 0,
        contribution: 0, ops: 0,
      };
      byUser.set(uid, a);
    }
    return a;
  };

  for (const e of events) {
    const dk = beijingDayKey(e.at);
    const di = dayIndex.get(dk);
    const a = accOf(e.uid);
    a.times.push(e.at.getTime());
    a.days.add(dk);
    a.ops += 1;
    a.contribution += eventWeight(e.type);
    if (di !== undefined) dayActiveUsers[di].add(e.uid);
    const ud = di !== undefined ? a.daily[di] : undefined; // 该用户当日桶

    if (e.type === "doc_create") { overview.docCreate++; a.docCreate++; if (di !== undefined) trends[di].docCreate++; if (ud) ud.docCreate++; }
    else if (isDocEdit(e.type)) { overview.docEdit++; a.docEdit++; if (di !== undefined) trends[di].docEdit++; if (ud) ud.docEdit++; }
    else if (e.type === "chat") { overview.chat++; a.chat++; if (di !== undefined) trends[di].chat++; if (ud) ud.chat++; }
    else if (e.type === "comment") { overview.comment++; a.comment++; if (di !== undefined) trends[di].comment++; if (ud) ud.comment++; }
    else if (e.type === "like") { overview.like++; a.like++; if (di !== undefined) trends[di].like++; if (ud) ud.like++; }
    else if (e.type === "view") { overview.view++; a.view++; if (di !== undefined) trends[di].view++; if (ud) ud.view++; }
    else if (e.type === "meeting") { overview.meeting++; a.meeting++; }
    else if (e.type === "bookmark") { overview.bookmark++; a.bookmark++; }
    else if (e.type === "upload") { overview.upload++; a.upload++; }
  }
  for (let i = 0; i < trends.length; i++) trends[i].activeUsers = dayActiveUsers[i].size;
  overview.activeUsers = byUser.size;

  // ── 被认可加分 ── 把本周内每个用户「收到的认可(被赞/被收藏/评论被赞)」加分
  // 叠加到其贡献度上(封顶 RECEIVED_WEEKLY_CAP)。只对本周已有操作的用户加(纯被
  // 认可、本周无操作的用户不新建行,保持简单)。
  const received = await receivedRecognition(week.weekStart, week.weekEnd, RECEIVED_WEEKLY_CAP);
  for (const [uid, bonus] of received) {
    const a = byUser.get(uid);
    if (a) a.contribution += bonus;
  }

  // ── 名称解析 ──
  const uids = [...byUser.keys()];
  const nameById = new Map(
    (await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, displayName: true } }))
      .map((u) => [u.id, u.displayName]),
  );
  const nameOf = (uid: string) => nameById.get(uid) ?? L(appLang(), "（已删除）", "(Deleted)");

  // 单用户/全员通用的行为构成饼图数据。
  const compositionFrom = (c: {
    docCreate: number; docEdit: number; chat: number; comment: number; like: number;
    view: number; bookmark: number; upload: number; meeting: number;
  }): WeeklyReportCompositionSlice[] => [
    { key: "docCreate", label: L(appLang(), "新建文档", "Docs created"), count: c.docCreate },
    { key: "docEdit", label: L(appLang(), "修改文档", "Docs edited"), count: c.docEdit },
    { key: "chat", label: L(appLang(), `向 ${ASSISTANT_NAME} 提问`, `Questions to ${ASSISTANT_NAME}`), count: c.chat },
    { key: "comment", label: L(appLang(), "评论", "Comments"), count: c.comment },
    { key: "like", label: L(appLang(), "点赞", "Likes"), count: c.like },
    { key: "view", label: L(appLang(), "查看文档", "Doc views"), count: c.view },
    { key: "bookmark", label: L(appLang(), "收藏", "Bookmarks"), count: c.bookmark },
    { key: "upload", label: L(appLang(), "上传", "Uploads"), count: c.upload },
    { key: "meeting", label: L(appLang(), "会议", "Meetings"), count: c.meeting },
  ].filter((s) => s.count > 0);

  // ── 用户明细(贡献度倒序)──
  const users: WeeklyReportUserRow[] = [...byUser.entries()].map(([uid, a]) => {
    const dur = durationMin(a.times);
    overview.totalDurationMin += dur;
    return {
      userId: uid,
      name: nameOf(uid),
      durationMin: dur,
      activeDays: a.days.size,
      docCreate: a.docCreate,
      docEdit: a.docEdit,
      chat: a.chat,
      comment: a.comment,
      like: a.like,
      view: a.view,
      contribution: Math.round(a.contribution * 10) / 10,
      ops: a.ops,
    };
  }).sort((x, y) => y.contribution - x.contribution || y.ops - x.ops);

  const topContributors = users.slice(0, 10).map((u) => ({ userId: u.userId, name: u.name, contribution: u.contribution }));

  // ── 用户维度(每用户趋势 + 构成),顺序对齐 users(贡献度倒序)──
  const userDimensions: WeeklyReportUserDimension[] = users.map((u) => {
    const a = byUser.get(u.userId)!;
    return { userId: u.userId, name: u.name, trends: a.daily, composition: compositionFrom(a) };
  });

  // ── 行为构成(全员饼图)──
  const composition = compositionFrom(overview);

  // ── 实时动态汇总(本周最近 100 条;详情页分页 10/页)──
  const liveActivity: WeeklyReportLiveItem[] = [...events]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 100)
    .map((e) => ({
      at: e.at.toISOString(),
      userId: e.uid,
      name: nameOf(e.uid),
      type: e.type,
      label: (appLang() === "en" ? TYPE_LABEL_EN : TYPE_LABEL)[e.type] ?? e.type,
      title: e.title,
    }));
  const safeLiveActivity = stripPrivateTitles(liveActivity);

  return {
    weekKey: week.weekKey,
    weekStart: week.weekStart.toISOString(),
    weekEnd: week.weekEnd.toISOString(),
    weekLabel: beijingWeekLabel(week),
    summary: buildSummary(beijingWeekLabel(week), overview, users),
    overview,
    trends,
    composition,
    userDimensions,
    users,
    topContributors,
    liveActivity: safeLiveActivity,
  };
}

// 生成并持久化一周的周报(weekKey 幂等)。regenerate=true 时覆盖重算。
export async function generateWeeklyReport(
  week: BeijingWeek,
  opts: { regenerate?: boolean } = {},
): Promise<{ id: string; weekKey: string; created: boolean }> {
  const existing = await prisma.weeklyReport.findUnique({ where: { weekKey: week.weekKey } });
  if (existing && !opts.regenerate) return { id: existing.id, weekKey: week.weekKey, created: false };
  const snapshot = await buildWeeklySnapshot(week);
  const base = { weekStart: week.weekStart, weekEnd: week.weekEnd, snapshot: JSON.stringify(snapshot) };
  if (existing) {
    await prisma.weeklyReport.update({ where: { weekKey: week.weekKey }, data: { ...base, generatedAt: new Date() } });
    return { id: existing.id, weekKey: week.weekKey, created: false };
  }
  // 并发兜底:手动刷新「本周」与周一定时定稿恰好命中同一 weekKey(周一 00:00 边界
  // 的亚秒级窗口)时,两路都可能走到 create → 后到者撞 weekKey @unique。捕获 P2002
  // 退化为 update,不抛错。定时侧 firstFinalize 取自写前 findUnique 快照,与此处的
  // created 无关,通知仍只发一次。
  try {
    const rec = await prisma.weeklyReport.create({ data: { weekKey: week.weekKey, ...base } });
    return { id: rec.id, weekKey: week.weekKey, created: true };
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const row = await prisma.weeklyReport.update({
      where: { weekKey: week.weekKey },
      data: { ...base, generatedAt: new Date() },
    });
    return { id: row.id, weekKey: week.weekKey, created: false };
  }
}

// 生成「上一个完整周」(相对 now)。
export function generatePreviousWeek(now: Date = new Date(), opts: { regenerate?: boolean } = {}) {
  return generateWeeklyReport(previousBeijingWeek(now), opts);
}

// 生成 / 刷新「本周(进行中)」(相对 now)。管理员手动刷新走这里:按北京自然周
// [本周一 00:00, 下周一 00:00) 重算本周实时快照(regenerate 覆盖)。
export function generateCurrentWeek(now: Date = new Date(), opts: { regenerate?: boolean } = {}) {
  return generateWeeklyReport(beijingWeekOf(now), opts);
}

// 定时定稿「上一个完整周」。若该周尚未定稿 —— 缺失,或只是周中手动刷过的「本周」
// partial(generatedAt < weekEnd)—— 则重算完整数据落库并标记 firstFinalize=true(供
// 发通知去重);已定稿(generatedAt ≥ weekEnd)直接跳过,使 boot-backfill 多次重启
// 不重复生成 / 通知。本周自然周的 weekEnd 是下周一 00:00,周中手动刷新时 now < weekEnd,
// 故手动刷新永不把该周标记为已定稿,周一定时仍会照常定稿 + 发通知。
export async function finalizePreviousWeek(
  now: Date = new Date(),
): Promise<{ id: string; weekKey: string; firstFinalize: boolean }> {
  const week = previousBeijingWeek(now);
  const existing = await prisma.weeklyReport.findUnique({ where: { weekKey: week.weekKey } });
  if (existing && existing.generatedAt.getTime() >= week.weekEnd.getTime()) {
    return { id: existing.id, weekKey: week.weekKey, firstFinalize: false };
  }
  const r = await generateWeeklyReport(week, { regenerate: true });
  return { id: r.id, weekKey: week.weekKey, firstFinalize: true };
}

export async function listWeeklyReports(): Promise<WeeklyReportListItem[]> {
  const rows = await prisma.weeklyReport.findMany({ orderBy: { weekStart: "desc" } });
  const out: WeeklyReportListItem[] = [];
  for (const r of rows) {
    // snapshot 只由本服务 JSON.stringify 写入,理论不会坏;仍逐行容错:坏行跳过,
    // 不让单条损坏数据 500 整个列表。
    try {
      const s = JSON.parse(r.snapshot) as WeeklyReportSnapshot;
      out.push({
        id: r.id,
        weekKey: r.weekKey,
        weekStart: r.weekStart.toISOString(),
        weekEnd: r.weekEnd.toISOString(),
        weekLabel: s.weekLabel,
        generatedAt: r.generatedAt.toISOString(),
        // 定稿口径与 finalizePreviousWeek 一致:生成于周结束之后即已定稿;否则是本周(进行中)。
        finalized: r.generatedAt.getTime() >= r.weekEnd.getTime(),
        activeUsers: s.overview.activeUsers,
        totalOps: s.overview.totalOps,
        totalDurationMin: s.overview.totalDurationMin,
      });
    } catch { /* skip corrupt row */ }
  }
  return out;
}

export async function getWeeklyReport(id: string): Promise<WeeklyReportDetailResponse | null> {
  const r = await prisma.weeklyReport.findUnique({ where: { id } });
  if (!r) return null;
  try {
    const snapshot = JSON.parse(r.snapshot) as WeeklyReportSnapshot;
    // 旧快照里可能已存了这几类标题，读取时一并剥掉。
    if (Array.isArray(snapshot.liveActivity)) snapshot.liveActivity = stripPrivateTitles(snapshot.liveActivity);
    return { id: r.id, generatedAt: r.generatedAt.toISOString(), snapshot };
  } catch {
    return null; // 损坏快照 → 当作不存在(路由返回 404)
  }
}

// ── 定时调度:每周一 00:00(北京)生成上一个完整周;开机补算缺失的上周 ──
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function runOnce(reason: string, log?: FastifyBaseLogger): Promise<void> {
  if (running || isRestoring()) return; // 还原热替换库期间不碰 DB
  running = true;
  try {
    const r = await finalizePreviousWeek(new Date());
    log?.info({ weekKey: r.weekKey, firstFinalize: r.firstFinalize, reason }, "weekly report finalized");
    // 仅在「首次定稿」该周时给管理员发飞书通知。定稿以 generatedAt 是否越过 weekEnd
    // 判定:周中手动刷过的「本周」partial 不算定稿,周一仍会发;已定稿的周重复启动
    // (boot-backfill)不重复打扰。
    if (r.firstFinalize) {
      const detail = await getWeeklyReport(r.id);
      if (detail) {
        await notifyAdminsOfWeeklyReport({
          id: r.id,
          weekLabel: detail.snapshot.weekLabel,
          // 刚生成的快照一定带 summary;`?? ""` 仅为满足类型(summary 现为可选,兼容旧快照)。
          summary: detail.snapshot.summary ?? "",
        }).catch((err) => log?.error({ err }, "weekly report admin notify failed"));
      }
    }
  } catch (err) {
    log?.error({ err, reason }, "weekly report generation failed");
  } finally {
    running = false;
  }
}

// 启动调度器(真实服务进程,index.ts 调用)。返回停止函数。
export function startWeeklyReportScheduler(log?: FastifyBaseLogger): () => void {
  let stopped = false;
  // 开机补算:确保「刚结束的上一整周」已生成(覆盖周一 0 点宕机错过的情况)。
  void runOnce("boot-backfill", log);
  const schedule = () => {
    if (stopped) return;
    const delay = msUntilNextBeijingMonday(new Date());
    timer = setTimeout(async () => {
      // 防早触发:setTimeout 可能略早于墙钟边界(定时器抖动 / 系统时钟微调),此时
      // now 仍在上一周内,previousBeijingWeek 会算成「上上周」。早醒时「距下一个
      // 周一」是到本次边界的一小段(< 1 分钟)→ 只重排剩余,不生成;准点/晚醒时
      // 该值已跳到 ≈7 天,正常生成。
      // (修正:此前条件写反了 —— `> 1000 → 跳过`,准点触发剩余 ≈7 天恒成立,
      // 定时生成从来没真正跑过,一直靠每次部署重启的 boot-backfill 兜着。)
      if (msUntilNextBeijingMonday(new Date()) < 60_000) {
        schedule();
        return;
      }
      await runOnce("weekly-cron", log);
      schedule(); // 自调度到下一个周一
    }, Math.max(delay, 1000)); // 给个下限,避免近零延迟空转
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
