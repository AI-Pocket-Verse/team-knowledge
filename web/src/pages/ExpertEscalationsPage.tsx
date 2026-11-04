import { useEffect, useMemo, useState } from "react";
import { api, type EscalationItem, type ExpertSummary } from "@/lib/api";
import { EscalationDecisionCard } from "@/components/experts/EscalationDecisionCard";

// 「我的待办」:我当前是 assignee 的升级单(我提问待我定 + 别人转交给我)。
// 每条用共用的 EscalationDecisionCard:可拍板或继续转交他人(链式)。拍板/转交后刷新列表。
export function ExpertEscalationsPage() {
  const [items, setItems] = useState<EscalationItem[] | null>(null);
  const [experts, setExperts] = useState<ExpertSummary[]>([]);

  function reload() {
    void api.agents.myEscalations().then((r) => setItems(r.items)).catch(() => setItems([]));
  }
  useEffect(() => {
    reload();
    void api.agents.list().then((r) => setExperts(r.experts)).catch(() => {});
  }, []);

  const roleName = useMemo(() => {
    const m = new Map(experts.map((e) => [e.roleId, e.name]));
    return (id: string) => m.get(id) ?? "专家";
  }, [experts]);

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <h1 className="text-[19px] font-semibold text-fg">我的待办</h1>
      <p className="mt-0.5 text-sm text-muted">需要你拍板的事项(你提问触发的,或别人转交给你的)。可直接定夺,或继续转交他人。</p>

      {items === null ? (
        <p className="mt-6 text-sm text-muted">加载中…</p>
      ) : items.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted">暂无待办,辛苦的事都处理完啦 🎉</p>
      ) : (
        <ul className="mt-5 space-y-3">
          {items.map((it) => (
            <li key={it.id} className="rounded-xl border border-line bg-white p-4 shadow-glass">
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-primary">{roleName(it.roleId)}专家</span>
                <span className="text-[11px] text-muted">{new Date(it.createdAt).toLocaleString("zh-CN")}</span>
              </div>
              <EscalationDecisionCard
                id={it.id}
                roleId={it.roleId}
                background={it.background}
                question={it.question}
                options={it.options}
                onResolved={reload}
                onForwarded={reload}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
