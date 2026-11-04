//助手内容过滤的核心解析器:把管理员维护的「排除清单」(AssistantExclusion 表里的
// role/folder/article 行)解析成三个 id 集合,并在级联(文件夹→子文件夹)后给检索
// (fts5 SQL)与文档体检(Prisma findMany)两处落地点提供可注入的 where 片段。
//
// 一篇文档被排除 ⟺ roleId ∈ roleIds 或 folderId ∈ folderIds 或 id ∈ articleIds。
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";

export interface AssistantExclusionSets {
  roleIds: Set<string>;    // 直接排除的角色
  folderIds: Set<string>;  // 直接排除的文件夹 ∪ 其子文件夹
  articleIds: Set<string>; // 直接排除的文档
}

// team-knowledge 单进程:模块级缓存 + 60s TTL 兜底;管理员增删后 invalidate 立即生效。
const TTL_MS = 60_000;
let cache: { sets: AssistantExclusionSets; at: number } | null = null;

export function invalidateAssistantExclusionCache(): void { cache = null; }

export async function getAssistantExclusionSets(): Promise<AssistantExclusionSets> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.sets;

  const rows = await prisma.assistantExclusion.findMany({ select: { targetType: true, targetId: true } });
  const roleIds = new Set<string>();
  const directFolderIds = new Set<string>();
  const articleIds = new Set<string>();
  for (const r of rows) {
    if (r.targetType === "role") roleIds.add(r.targetId);
    else if (r.targetType === "folder") directFolderIds.add(r.targetId);
    else if (r.targetType === "article") articleIds.add(r.targetId);
  }

  // 文件夹最多两级:把直接排除文件夹的子文件夹并进来(一层展开)。
  const folderIds = new Set(directFolderIds);
  if (directFolderIds.size > 0) {
    const subs = await prisma.folder.findMany({
      where: { parentId: { in: [...directFolderIds] } },
      select: { id: true },
    });
    for (const s of subs) folderIds.add(s.id);
  }

  const sets: AssistantExclusionSets = { roleIds, folderIds, articleIds };
  cache = { sets, at: now };
  return sets;
}

// 中央检索(fts5)用:返回拼在 `AND (whereCombined)` 之后的 SQL 片段(自带前导 " AND ")。
// 空集合返回 Prisma.empty(行为不变)。Article 别名约定为 "a"。
export function exclusionSqlFilter(sets: AssistantExclusionSets): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (sets.roleIds.size > 0) clauses.push(Prisma.sql`a.roleId NOT IN (${Prisma.join([...sets.roleIds])})`);
  if (sets.folderIds.size > 0) clauses.push(Prisma.sql`(a.folderId IS NULL OR a.folderId NOT IN (${Prisma.join([...sets.folderIds])}))`);
  if (sets.articleIds.size > 0) clauses.push(Prisma.sql`a.id NOT IN (${Prisma.join([...sets.articleIds])})`);
  if (clauses.length === 0) return Prisma.empty;
  return Prisma.sql` AND ${Prisma.join(clauses, " AND ")}`;
}

// 文档体检(Prisma findMany)用:返回可并入 where 的片段(空集合→空对象,即不加条件)。
export function exclusionPrismaWhere(sets: AssistantExclusionSets): Prisma.ArticleWhereInput {
  const where: Prisma.ArticleWhereInput = {};
  if (sets.roleIds.size > 0) where.roleId = { notIn: [...sets.roleIds] };
  if (sets.articleIds.size > 0) where.id = { notIn: [...sets.articleIds] };
  if (sets.folderIds.size > 0) where.OR = [{ folderId: null }, { folderId: { notIn: [...sets.folderIds] } }];
  return where;
}
