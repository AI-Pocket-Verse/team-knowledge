import type { ExpertTraceEvent } from "@/lib/api";
import { getAssistantName } from "@/lib/assistantName";
import { tr } from "@/i18n";

// 专家对话「进行中」的实时阶段文案。由编排过程事件(liveTrace)推导,
// 让用户在【非流式 provider(如 codex)】或【分诊阶段尚无 token】时也能看到进展,
// 而不是一直停在静态的「思考中…」。
export function streamingStatus(
  liveTrace: ExpertTraceEvent[] | undefined,
  roleName: (id: string) => string,
): string {
  const lt = liveTrace ?? [];
  if (lt.some((e) => e.type === "image")) return tr("experts.status.image");
  if (lt.some((e) => e.type === "websearch")) return tr("experts.status.websearch");
  if (lt.some((e) => e.type === "escalation")) return tr("experts.status.escalation");
  if (lt.some((e) => e.type === "summarized")) return tr("experts.status.summarized");
  if (lt.some((e) => e.type === "consult")) return tr("experts.status.consult");
  const routed = lt.find((e) => e.type === "routed");
  if (routed) {
    const ids = routed.roleIds ?? [];
    if (ids.length === 0) return tr("experts.status.thinking", { name: getAssistantName() });
    return tr("experts.status.answering", { roles: ids.map(roleName).join(tr("common.listSep")) });
  }
  // 还没有分诊结果:一律先显示「助手思考中…」。即便用户选了专家,也要先经助手
  // 门控判断——只有收到 routed 事件(确需该专家)才翻成「xx 专家应答中…」,
  // 避免一上来就误显「xx 专家应答中…」却其实是通用问题该助手自答。
  return tr("experts.status.thinking", { name: getAssistantName() });
}
