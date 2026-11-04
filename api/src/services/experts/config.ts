// 专家地基:角色专家设定(instruction / 负责人 / 来源开关 / 启用)的读写。
// 1:1 与 Role。无行时返回默认(enabled、默认来源、无负责人),管理员配置后落 RoleExpert 表。
import { prisma } from "../../db.js";

export interface ExpertSources {
  // 知识库文档(全库共享,所有专家都能检索;非本角色专属。默认开)
  kbDocs: boolean;
  crossModule: boolean;  // 内部跨模块:会议纪要 / 群答疑(默认开)
  webSearch: boolean;    // 联网搜索(claude WebSearch,默认关)
  consult: boolean;      // 允许跨角色请教(获取别的角色专家的 skill/视角,默认开)
}

export const DEFAULT_SOURCES: ExpertSources = { kbDocs: true, crossModule: true, webSearch: false, consult: true };

export interface ExpertConfig {
  roleId: string;
  instruction: string;
  ownerUserId: string | null;
  avatarUrl: string | null;   // 专家头像(/uploads/<file>);null = 用首字渐变占位
  sources: ExpertSources;
  enabled: boolean;
}

// 解析持久化的 sources JSON;损坏/缺字段 → 用默认补齐,绝不抛。
function parseSources(json: string): ExpertSources {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object") return DEFAULT_SOURCES;
    return { ...DEFAULT_SOURCES, ...(v as Partial<ExpertSources>) };
  } catch {
    return DEFAULT_SOURCES;
  }
}

export async function getExpert(roleId: string): Promise<ExpertConfig> {
  const row = await prisma.roleExpert.findUnique({ where: { roleId } });
  if (!row) return { roleId, instruction: "", ownerUserId: null, avatarUrl: null, sources: DEFAULT_SOURCES, enabled: true };
  return {
    roleId,
    instruction: row.instruction,
    ownerUserId: row.ownerUserId,
    avatarUrl: row.avatarUrl,
    sources: parseSources(row.sources),
    enabled: row.enabled,
  };
}

/** 批量读取多个角色的专家设定(消除「按角色循环 getExpert」的 N+1)。一次 findMany,
 *  未配置的角色补默认。返回 roleId → ExpertConfig 的 Map。 */
export async function getExpertsByRoleIds(roleIds: string[]): Promise<Map<string, ExpertConfig>> {
  const rows = roleIds.length > 0
    ? await prisma.roleExpert.findMany({ where: { roleId: { in: roleIds } } })
    : [];
  const byId = new Map(rows.map((r) => [r.roleId, r]));
  const out = new Map<string, ExpertConfig>();
  for (const roleId of roleIds) {
    const row = byId.get(roleId);
    out.set(roleId, row
      ? { roleId, instruction: row.instruction, ownerUserId: row.ownerUserId, avatarUrl: row.avatarUrl, sources: parseSources(row.sources), enabled: row.enabled }
      : { roleId, instruction: "", ownerUserId: null, avatarUrl: null, sources: DEFAULT_SOURCES, enabled: true });
  }
  return out;
}

export async function setExpert(
  roleId: string,
  patch: Partial<Omit<ExpertConfig, "roleId">>,
  by: string,
): Promise<ExpertConfig> {
  const cur = await getExpert(roleId);
  const next = { ...cur, ...patch };
  const data = {
    instruction: next.instruction,
    ownerUserId: next.ownerUserId,
    avatarUrl: next.avatarUrl,
    sources: JSON.stringify(next.sources),
    enabled: next.enabled,
    updatedById: by,
  };
  await prisma.roleExpert.upsert({
    where: { roleId },
    create: { roleId, ...data },
    update: data,
  });
  return getExpert(roleId);
}
