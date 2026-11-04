import type { ExpertTraceEvent } from "@/lib/api";
import { getAssistantName } from "@/lib/assistantName";
import { useT } from "@/i18n";

// 样式 1 飞书原生:把「分诊 / 谁作答 / 是否汇总」收成一行克制的灰色可折叠 <details>,
// 默认折叠成一句话,点开看明细。无路由也无作答时不渲染。
export function ExpertStepTrace({ trace, roleName }: { trace: ExpertTraceEvent[]; roleName: (id: string) => string }) {
  const t = useT();
  const routed = trace.find((t) => t.type === "routed")?.roleIds ?? [];
  const answered = trace.filter((t) => t.type === "answered").map((t) => t.roleId!).filter(Boolean) as string[];
  const consulted = trace.filter((t) => t.type === "consult").map((t) => t.roleId!).filter(Boolean) as string[];
  const escalated = trace.some((t) => t.type === "escalation");
  const summarized = trace.some((t) => t.type === "summarized");
  if (routed.length === 0 && answered.length === 0) return null;

  const summary = routed.length === 0
    ? t("experts.trace.noneSummary", { name: getAssistantName() })
    : t("experts.trace.routedSummary", {
        name: getAssistantName(),
        roles: routed.map(roleName).join(t("common.listSep")),
        consulted: consulted.length ? t("experts.trace.consultedTag") : "",
        state: escalated ? t("experts.trace.escalatedTag") : summarized ? t("experts.trace.summarizedTag") : "",
      });

  return (
    <details className="rounded-lg bg-surface px-3 py-1.5 text-xs text-muted">
      <summary className="cursor-pointer select-none">{summary}</summary>
      <ul className="mt-1 space-y-0.5 pl-1 text-[11px]">
        <li>{t("experts.trace.routed", { roles: routed.length ? routed.map(roleName).join(t("common.listSep")) : t("experts.trace.noMatch") })}</li>
        {answered.map((rid, i) => (
          <li key={`a${i}`}>{t("experts.trace.answered", { role: roleName(rid) })}</li>
        ))}
        {consulted.map((rid, i) => (
          <li key={`c${i}`}>{t("experts.trace.consulted", { role: roleName(rid) })}</li>
        ))}
        {escalated && <li className="text-amber-600">{t("experts.trace.escalated")}</li>}
        {summarized && <li>{t("experts.trace.summarized", { name: getAssistantName() })}</li>}
      </ul>
    </details>
  );
}
