import type { ExpertTraceEvent } from "@/lib/api";
import { getAssistantName } from "@/lib/assistantName";

// 样式 1 飞书原生:把「分诊 / 谁作答 / 是否汇总」收成一行克制的灰色可折叠 <details>,
// 默认折叠成一句话,点开看明细。无路由也无作答时不渲染。
export function ExpertStepTrace({ trace, roleName }: { trace: ExpertTraceEvent[]; roleName: (id: string) => string }) {
  const routed = trace.find((t) => t.type === "routed")?.roleIds ?? [];
  const answered = trace.filter((t) => t.type === "answered").map((t) => t.roleId!).filter(Boolean) as string[];
  const consulted = trace.filter((t) => t.type === "consult").map((t) => t.roleId!).filter(Boolean) as string[];
  const escalated = trace.some((t) => t.type === "escalation");
  const summarized = trace.some((t) => t.type === "summarized");
  if (routed.length === 0 && answered.length === 0) return null;

  const summary = routed.length === 0
    ? `${getAssistantName()} 未匹配到专属专家,由 ${getAssistantName()} 作答`
    : `${getAssistantName()} 分诊 → ${routed.map(roleName).join("、")}专家${consulted.length ? "(有请教)" : ""}${escalated ? "(已升级)" : summarized ? "(已汇总)" : ""}`;

  return (
    <details className="rounded-lg bg-surface px-3 py-1.5 text-xs text-muted">
      <summary className="cursor-pointer select-none">{summary}</summary>
      <ul className="mt-1 space-y-0.5 pl-1 text-[11px]">
        <li>· 分诊:{routed.length ? routed.map(roleName).join("、") : "未匹配到专属专家"}</li>
        {answered.map((rid, i) => (
          <li key={`a${i}`}>· {roleName(rid)}专家已作答</li>
        ))}
        {consulted.map((rid, i) => (
          <li key={`c${i}`}>· 请教了 {roleName(rid)}专家</li>
        ))}
        {escalated && <li className="text-amber-600">· 已升级给负责人(飞书),等待回流</li>}
        {summarized && <li>· {getAssistantName()} 已把多位专家意见汇总成一份答复</li>}
      </ul>
    </details>
  );
}
