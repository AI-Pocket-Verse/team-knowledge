import type { UiChatMessage } from "@/stores/chat";
import { ExpertStepTrace } from "@/components/experts/ExpertStepTrace";
import { CitationChips } from "@/components/experts/CitationChips";
import { EscalationDecisionCard } from "@/components/experts/EscalationDecisionCard";
import { streamingStatus } from "@/components/experts/streamingStatus";

// assistant 卡的专家附加件。trace===undefined → 气泡旧链路,不渲染。
// 流式且无正文 → 实时阶段状态(非流式 provider 也有进展反馈);
// 终稿 → 折叠 trace + 升级决策卡(未处理) + 出处芯片。
export function ExpertAnswerExtras({ m, roleName, streaming, onEscalationHandled }: {
  m: UiChatMessage;
  roleName: (id: string) => string;
  streaming: boolean;
  onEscalationHandled: (messageId: string) => void;
}) {
  const hasTrace = m.trace !== undefined; // 当轮专家编排(实时 trace / 状态)
  const hasCitations = !!m.citations && m.citations.length > 0; // 终稿/刷新重建的出处
  if (!hasTrace && !hasCitations) return null; // 既无编排也无出处(气泡纯文本 / 旧链路)

  // 生图阶段:模型已先吐出「思路/构图」前言(m.content 非空),随后系统还在调文生图(最长 120s,
  // 图尚未落地 → m.images 为空)。此时仍要把「正在生成图片…」挂在前言下方,否则这段等待会毫无进度反馈、
  // 看着像已答完却又迟迟蹦出图。普通(非生图)打字机输出不受影响:trace 无 image 事件 → 不触发。
  const generatingImage = !!m.trace?.some((t) => t.type === "image") && !(m.images?.length);

  if (streaming && hasTrace && (!m.content || generatingImage)) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary/60" />
        {streamingStatus(m.trace, roleName)}
      </p>
    );
  }
  if (streaming) return null; // 正文正在打字机输出,附加件等终稿再出

  return (
    <div className="mt-2.5 space-y-2">
      {m.trace && m.trace.length > 0 && <ExpertStepTrace trace={m.trace} roleName={roleName} />}
      {m.escalation && !m.escalationHandled && (
        <EscalationDecisionCard
          id={m.escalation.id}
          roleId={m.escalation.roleId}
          background={m.escalation.background}
          question={m.escalation.question}
          options={m.escalation.options}
          onResolved={() => onEscalationHandled(m.id)}
          onForwarded={() => onEscalationHandled(m.id)}
        />
      )}
      {m.citations && <CitationChips citations={m.citations} />}
    </div>
  );
}
