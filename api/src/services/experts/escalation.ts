// 专家地基:人工升级单状态机。专家卡住/需拍板时 createEscalation(并由上层发飞书卡片),
// 负责人回流走 resolveEscalation(幂等:仅 pending→resolved),超时走 expireEscalation。
// 条件写(WHERE status='pending')保证幂等,resolvedAt 用 epoch-ms(与库内 DateTime 约定一致)。
import { prisma } from "../../db.js";
import { feishuGateway } from "../../utils/feishuGateway.js";

export interface NewEscalation {
  conversationId: string;
  roleId: string;
  background: string;
  question: string;
  options: string[];
  assigneeUserId: string | null;
}

export async function createEscalation(e: NewEscalation) {
  return prisma.escalation.create({
    data: {
      conversationId: e.conversationId,
      roleId: e.roleId,
      background: e.background,
      question: e.question,
      options: JSON.stringify(e.options ?? []),
      assigneeUserId: e.assigneeUserId,
    },
  });
}

/** 幂等:仅 pending → resolved + 写结论 + 记解决人。已终态忽略。返回当前行。 */
export async function resolveEscalation(id: string, by: { resolution: string; by: string }) {
  await prisma.$executeRaw`
    UPDATE "Escalation"
       SET "status" = 'resolved', "resolution" = ${by.resolution}, "resolvedById" = ${by.by}, "resolvedAt" = ${Date.now()}
     WHERE "id" = ${id} AND "status" = 'pending'`;
  return prisma.escalation.findUniqueOrThrow({ where: { id } });
}

/** 幂等:仅 pending → timeout。已终态忽略。 */
export async function expireEscalation(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Escalation"
       SET "status" = 'timeout', "resolvedAt" = ${Date.now()}
     WHERE "id" = ${id} AND "status" = 'pending'`;
}

// ─── C4:升级 → 飞书结构化卡片 ──────────────────────────────────────
export type SendEscalationCard = (openId: string, card: unknown) => Promise<{ messageId: string }>;

export interface EscalationCardInput {
  roleName: string;
  background: string;   // 卡在哪
  question: string;     // 需要你定什么
  options: string[];    // 候选
}

/** 飞书 interactive 卡片:背景 + 问题 + 候选按钮(value 带 escalationId+option,供回调回流)+ 「也可直接回复」。 */
export function buildEscalationCard(escalationId: string, input: EscalationCardInput): unknown {
  const actions = input.options.map((opt) => ({
    tag: "button",
    text: { tag: "plain_text", content: opt },
    type: "primary",
    value: { kind: "expert_escalation", escalationId, option: opt },
  }));
  return {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: { tag: "plain_text", content: `「${input.roleName}专家」需要你拍板` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**卡在哪**\n${input.background}` } },
      { tag: "div", text: { tag: "lark_md", content: `**需要你定**\n${input.question}` } },
      ...(actions.length > 0 ? [{ tag: "action", actions }] : []),
      { tag: "note", elements: [{ tag: "plain_text", content: "也可直接回复本消息给出方案" }] },
    ],
  };
}

// ─── 转交:把 pending 升级单改派给他人 + 给新负责人发飞书卡片 ──────────────
export interface ForwardInput { toUserId: string; byUserId: string; roleName: string; }
export interface ForwardResult { ok: boolean; cardSent?: boolean; reason?: "not-pending" | "bad-target" }

function parseOptions(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}

/** 转交:校验目标为真实启用用户 → 仅 pending 时改派(记 assignedById)→ 给新 assignee 发飞书卡片。
 *  授权(必须是当前 assignee/管理员)在路由层校验。幂等:非 pending 直接返回 not-pending,不改单、不发卡。 */
export async function forwardEscalation(
  id: string,
  input: ForwardInput,
  opts: { sendCard?: SendEscalationCard } = {},
): Promise<ForwardResult> {
  const target = await prisma.user.findUnique({ where: { id: input.toUserId }, select: { ssoId: true, isActive: true } });
  if (!target || !target.isActive) return { ok: false, reason: "bad-target" };
  const n = await prisma.$executeRaw`
    UPDATE "Escalation" SET "assigneeUserId" = ${input.toUserId}, "assignedById" = ${input.byUserId}
     WHERE "id" = ${id} AND "status" = 'pending'`;
  if (n === 0) return { ok: false, reason: "not-pending" };
  const esc = await prisma.escalation.findUniqueOrThrow({ where: { id } });
  // 仅当目标有飞书 open_id 时发卡;发卡失败不回滚(站内待办仍可见),cardSent=false。
  if (!target.ssoId?.startsWith("ou_")) return { ok: true, cardSent: false };
  const send = opts.sendCard ?? feishuGateway.notify;
  try {
    const card = buildEscalationCard(esc.id, { roleName: input.roleName, background: esc.background, question: esc.question, options: parseOptions(esc.options) });
    const { messageId } = await send(target.ssoId, card);
    await prisma.escalation.update({ where: { id }, data: { feishuMessageId: messageId } }).catch(() => { /* 卡片已送达,仅引用落库失败 */ });
    return { ok: true, cardSent: true };
  } catch {
    return { ok: true, cardSent: false };
  }
}
