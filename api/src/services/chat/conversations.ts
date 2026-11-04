// 会话生命周期集中地:建/取/列/改名/删/触达。取代旧的 getOrCreateConversation
// (其 upsert 依赖已删除的 (userId, roleId) 唯一键)。
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";

// 自动标题的存储上限:取首条消息前 TITLE_MAX 字(超出补「…」标示被截)。设得宽一些,让顶栏/边栏
// 各自按实际宽度用 CSS truncate 再省略 —— 既能尽量展示、放不下也有「…」,不再像旧的 16 字那样早早切短、
// 一行后面留一大片空白还没有省略号。用户可随时改名(改名上限 60)。
const TITLE_MAX = 40;

/** 首条用户消息 → 标题;超长截断并补「…」;空白兜底「新对话」。 */
export function deriveTitle(firstMessage: string): string {
  const t = firstMessage.trim();
  if (!t) return "新对话";
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + "…" : t;
}

/** 新建一条普通多任务会话(singletonKey=null → 可有任意多条)。
 *  lastMessageAt 初始化为创建时刻 —— 列表按 lastMessageAt 倒序,新会话据此立刻排到最前
 *  (而非因 lastMessageAt=null 被 NULLS LAST 沉到底);后续 touchConversation 只会把它往后推。 */
export function createConversation(userId: string, title?: string | null) {
  return prisma.conversation.create({ data: { userId, singletonKey: null, title: title ?? null, lastMessageAt: new Date() } });
}

/** 该用户飞书专用会话:每用户唯一、幂等。并发竞态由 @@unique([userId, singletonKey]) 兜底。 */
export async function getOrCreateFeishuConversation(userId: string) {
  const existing = await prisma.conversation.findFirst({ where: { userId, singletonKey: "feishu" } });
  if (existing) return existing;
  try {
    return await prisma.conversation.create({ data: { userId, singletonKey: "feishu" } });
  } catch (e) {
    // P2002:另一并发请求刚建好 → 重取。
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await prisma.conversation.findFirst({ where: { userId, singletonKey: "feishu" } });
      if (again) return again;
    }
    throw e;
  }
}

/** 按 id 取会话并校验归属;非本人或不存在 → null。 */
export async function getOwnedConversation(userId: string, conversationId: string) {
  return prisma.conversation.findFirst({ where: { id: conversationId, userId } });
}

export interface ConversationListItem {
  id: string; title: string | null; isFeishu: boolean; pinned: boolean;
  lastMessageAt: string | null; createdAt: string;
}

/**
 * 会话列表:飞书常驻置顶,其余按 lastMessageAt(兜底 createdAt)倒序。
 * 飞书会话是「常驻」入口 —— 这里用 getOrCreate 确保它总存在并置顶(即便用户还没收过任何
 * 飞书私聊),这样「飞书对话」永远在列表顶部、可点开查看历史/继续。它不占 limit 名额;
 * 其余在 DB 层 take limit+1 判断 hasMore(避免整表读入内存再切片)。hasMore 只反映「非飞书」剩余。
 */
export async function listConversations(
  userId: string, opts: { limit?: number; offset?: number } = {},
): Promise<{ items: ConversationListItem[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  // offset 翻页(左栏「加载更多」):飞书会话只在第一页(offset=0)常驻置顶,翻页不再带它,
  // 也不必 getOrCreate;非飞书会话用 skip 翻页。offset 按「已加载的非飞书条数」算(前端传)。
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const [feishu, rows] = await Promise.all([
    offset === 0 ? getOrCreateFeishuConversation(userId) : Promise.resolve(null),
    prisma.conversation.findMany({
      // 「非飞书」=普通会话(singletonKey=null)或任何其它哨兵。注意不能写 NOT:{singletonKey:"feishu"}
      // ——SQL 三值逻辑下它会把 singletonKey IS NULL 的普通会话一并排除(NULL<>'feishu' 为 NULL,非真)。
      // messages.some:只列「有过对话(≥1 条消息)」的会话 —— 空会话(如首发在落用户消息前中断/
      // 报错留下的 0 消息空壳)不显示,避免点开是「Hi助手」空态。正在进行的新对话在首条消息
      // 落库前不是 DB 行、本就不在列表,不受影响。
      where: { userId, messages: { some: {} }, OR: [{ singletonKey: null }, { singletonKey: { not: "feishu" } }] },
      // 置顶优先(pinnedAt 非空、按倒序),其余按最近活跃。飞书仍在最顶(单独 prepend)。
      orderBy: [
        { pinnedAt: { sort: "desc", nulls: "last" } },
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      skip: offset,
      take: limit + 1,
    }),
  ]);
  // 飞书会话仅在【已有消息】时才置顶展示:空的单例(自动创建但用户还没聊过飞书)不进列表,
  // 免得出现「点开却是 Hi助手空态」的飞书对话条。有历史后自然出现。注意用 count 而非
  // lastMessageAt —— notify-only 消息(assistantNotify)不 touchConversation,lastMessageAt 可能为
  // null 但确有消息,故按消息数判定。
  const feishuShown = feishu && (await prisma.chatMessage.count({ where: { conversationId: feishu.id } })) > 0 ? feishu : null;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const toItem = (c: { id: string; title: string | null; singletonKey: string | null; pinnedAt: Date | null; lastMessageAt: Date | null; createdAt: Date }): ConversationListItem => ({
    id: c.id, title: c.title, isFeishu: c.singletonKey === "feishu", pinned: c.pinnedAt != null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
  });
  const items = [...(feishuShown ? [feishuShown] : []), ...page].map(toItem);
  return { items, hasMore };
}

/** 改名,带归属校验;改到则 true。 */
export async function renameConversation(userId: string, conversationId: string, title: string): Promise<boolean> {
  const r = await prisma.conversation.updateMany({ where: { id: conversationId, userId }, data: { title: title.slice(0, 60) } });
  return r.count > 0;
}

/** 置顶 / 取消置顶,带归属校验;改到则 true。pinned=true → pinnedAt=now;false → null。 */
export async function pinConversation(userId: string, conversationId: string, pinned: boolean): Promise<boolean> {
  const r = await prisma.conversation.updateMany({ where: { id: conversationId, userId }, data: { pinnedAt: pinned ? new Date() : null } });
  return r.count > 0;
}

/** 删会话(级联删消息),带归属校验;删到则 true。 */
export async function deleteConversation(userId: string, conversationId: string): Promise<boolean> {
  const owned = await getOwnedConversation(userId, conversationId);
  if (!owned) return false;
  await prisma.chatMessage.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  return true;
}

/** 落一条消息后把会话 lastMessageAt 推到该时刻(列表排序用)。失败软吞。 */
export async function touchConversation(conversationId: string, at: Date = new Date()): Promise<void> {
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at } }).catch(() => {});
}
