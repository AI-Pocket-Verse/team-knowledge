// 专家地基:总台分诊。显式 @角色 → 直接路由;否则让 LLM 看「角色清单 + 各专家设定摘要 + 问题」
// 选出该找哪些专家(0~N 个)。解析容错;选不出 / 非法 → 返回 [](总台自答)。
export interface TriageRole { roleId: string; name: string; instruction: string; }
export type RunTriageLlm = (system: string, user: string) => Promise<string | null>;

const MAX_EXPERTS = 3;

// 稳健抽 {roleIds:[...]}:剥代码块、取最外层 {…},失败 → []。
// 元素可能是角色 id,也可能是角色名称(LLM 抄长 cuid 易错,故让它填名称更稳)——
// 解析阶段只取出字符串数组,id/名称的归一交给下面的 resolve。
function parseEntries(text: string): string[] {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const i = stripped.indexOf("{");
  const j = stripped.lastIndexOf("}");
  if (i < 0 || j < i) return [];
  try {
    const obj = JSON.parse(stripped.slice(i, j + 1)) as { roleIds?: unknown };
    return Array.isArray(obj.roleIds) ? obj.roleIds.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function buildTriageSystem(roles: TriageRole[]): string {
  const list = roles.map((r) => `- ${r.name}${r.instruction ? `(${r.instruction.slice(0, 40)})` : ""}`).join("\n");
  return `你是团队助手的「分诊台」。下面是可用的角色专家清单,请判断用户的问题应该找哪些专家回答。
专家清单:
${list}
规则:选最相关的专家;明显跨多个角色才选多个(至多 ${MAX_EXPERTS} 个);没有合适专家就返回空。
严格只输出 JSON,用角色【名称】填充:{"roleIds":["角色名称", ...]}`;
}

/** 分诊。显式 targetRoleIds 优先(过滤到清单内);否则 LLM 选;结果归一为清单内 roleId,去重、限 ${MAX_EXPERTS} 个。
 *  归一同时接受 id 与名称:LLM 让填名称(更稳),但若它回了 id 也照样认。 */
export async function triage(
  question: string,
  roles: TriageRole[],
  opts: { targetRoleIds?: string[]; runLlm?: RunTriageLlm } = {},
): Promise<string[]> {
  const byId = new Map(roles.map((r) => [r.roleId, r.roleId]));
  const byName = new Map(roles.map((r) => [r.name.trim(), r.roleId]));
  // 把 LLM 给的「id 或名称」归一到 roleId:先按 id,再按精确名,最后按子串兜底——
  // 但子串必须【唯一命中】才认,否则(如「技术」既匹配「技术」又匹配「技术支持」)宁可跳过,
  // 避免 first-match-wins 误路由到错误角色。
  const resolve = (entry: string): string | null => {
    const e = entry.trim();
    if (!e) return null;
    if (byId.has(e)) return byId.get(e)!;
    if (byName.has(e)) return byName.get(e)!;
    const subMatches = roles.filter((r) => e.includes(r.name) || r.name.includes(e));
    return subMatches.length === 1 ? subMatches[0]!.roleId : null;
  };
  const clampIds = (ids: string[]) => [...new Set(ids)].filter((id) => byId.has(id)).slice(0, MAX_EXPERTS);
  const resolveAll = (entries: string[]) =>
    [...new Set(entries.map(resolve).filter((id): id is string => id !== null))].slice(0, MAX_EXPERTS);

  if (opts.targetRoleIds && opts.targetRoleIds.length > 0) {
    return clampIds(opts.targetRoleIds);
  }
  if (roles.length === 0) return [];

  const runLlm = opts.runLlm;
  if (!runLlm) return [];
  const text = await runLlm(buildTriageSystem(roles), `用户问题:${question}`);
  if (text === null) return [];
  return resolveAll(parseEntries(text));
}
