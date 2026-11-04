import { useState } from "react";
import { api, type RoleMember } from "@/lib/api";
import { UserPicker } from "./UserPicker";
import { toast } from "@/components/Toaster";

// 决策卡:拍板(候选/自由文本)或转交他人。用于专家对话气泡内与「我的待办」。
// onResolved/onForwarded 让上层刷新(对话内可隐藏卡;待办里 reload)。
export function EscalationDecisionCard({ id, roleId, background, question, options, onResolved, onForwarded }: {
  id: string; roleId: string; background: string; question: string; options: string[];
  onResolved?: () => void; onForwarded?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [members, setMembers] = useState<RoleMember[]>([]);

  function openForward() {
    setForwarding(true);
    void api.roles.members(roleId).then((r) => setMembers(r.members)).catch(() => setMembers([]));
  }
  async function resolve(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await api.agents.resolveEscalation(id, text); toast.success("已拍板"); onResolved?.(); }
    catch (e) { toast.error((e as Error).message || "提交失败"); }
    finally { setBusy(false); }
  }
  async function forward(toUserId: string) {
    if (busy) return;
    setBusy(true);
    try { await api.agents.forwardEscalation(id, toUserId); toast.success("已转交"); onForwarded?.(); }
    catch (e) { toast.error((e as Error).message || "转交失败"); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="font-medium text-amber-700">需要你拍板</div>
      <div className="mt-1 text-muted">卡在哪</div>
      <div className="whitespace-pre-wrap text-fg">{background}</div>
      <div className="mt-1 text-muted">需要你定</div>
      <div className="whitespace-pre-wrap font-medium text-fg">{question}</div>

      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o, i) => (
          <button key={i} type="button" disabled={busy} onClick={() => void resolve(o)}
            className="rounded-lg border border-primary/40 bg-white px-3 py-1 text-primary transition hover:bg-primary hover:text-primary-fg disabled:opacity-50">
            {o}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="或写下你的方案…"
          className="flex-1 rounded-lg border border-line px-2 py-1 outline-none" disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void resolve(draft); } }} />
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void resolve(draft)}
          className="rounded-lg bg-primary px-3 py-1 text-primary-fg disabled:opacity-50">拍板</button>
        <button type="button" disabled={busy} onClick={() => openForward()}
          className="rounded-lg border border-line px-3 py-1 text-fg hover:bg-surface">转交他人</button>
      </div>

      {forwarding && (
        <div className="mt-2">
          <div className="mb-1 text-xs text-muted">转交给(默认列该角色成员,也可按名搜):</div>
          <UserPicker suggestions={members} value={null} onChange={(uid) => { if (uid) void forward(uid); }} />
        </div>
      )}
    </div>
  );
}
