// Prompt for synthesizing a role's skill.md from its published docs. Output is
// a Claude Agent Skill (frontmatter + body), "二者结合": overview/usage
// (instruction) + distilled knowledge + a complete doc index (knowledge).

export const SKILL_SYSTEM_PROMPT = `你是资深知识工程师。基于给定的某个「角色(知识空间)」及其【已发布文档】,产出一份高质量的 \`skill.md\`,用作 Claude Code / Codex 的 Agent Skill。

严格要求:
1. 只输出 markdown 本身,不要任何额外解释、不要代码围栏包裹整篇。
2. 开头必须是 YAML frontmatter,且仅含两个字段:
   - name: 一个简短的英文 kebab-case 标识(小写字母/数字/连字符),由角色名意译或音译而来。
   - description: 一句话(≤200 字),说明本 skill 覆盖什么知识、何时使用。
3. frontmatter 之后,正文用中文,包含以下小节(标题用 ## ):
   - ## 用途 / 何时使用 —— 这个角色/知识域是什么,什么场景应使用本 skill。
   - ## 使用说明 —— Claude/Codex 应如何使用其中知识作答:适用范围、口径、边界、引用方式。
   - ## 关键知识 —— 从文档中提炼的事实/规则/约定/流程,分条列出,务必忠于原文,不要杜撰。
   - ## 文档索引 —— 列出全部已发布文档(用我提供的清单),每条可补一句话摘要。
4. 忠实于所给文档;信息不足时如实说明,不要编造。语言简洁、信息密度高。`;

export function buildSkillUserMessage(input: {
  roleName: string;
  roleDescription: string | null;
  packedBody: string;
  docIndex: string;
  docCount: number;
  truncated: number;
}): string {
  const meta = [
    `角色名称:${input.roleName}`,
    input.roleDescription ? `角色描述:${input.roleDescription}` : null,
    `已发布文档数:${input.docCount}`,
    input.truncated > 0 ? `注意:其中 ${input.truncated} 篇因篇幅仅提供了标题+开头,请在「文档索引」中仍完整列出它们。` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${meta}

【文档索引(请在 skill 的「文档索引」小节完整保留这些标题)】
${input.docIndex}

【已发布文档正文(用于提炼「关键知识」)】
${input.packedBody}

请据此产出该角色的 skill.md(含 frontmatter)。`;
}
