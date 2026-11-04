import { useState } from "react";
import { api, type RoleMember } from "@/lib/api";
import { UserPicker } from "./UserPicker";
import { toast } from "@/components/Toaster";
import { useT } from "@/i18n";

// 决策卡:拍板(候选/自由文本)或转交他人。用于专家对话气泡内与「我的待办」。
// onResolved/onForwarded 让上层刷新(对话内可隐藏卡;待办里 reload)。
export function EscalationDecisionCard({ id, roleId, background, question, options, onResolved, onForwarded }: {
  id: string; roleId: string; background: string; question: string; options: string[];
  onResolved?: () => void; onForwarded?: () => void;
}) {
  const t = useT();
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
    try { await api.agents.resolveEscalation(id, text); toast.success(t("experts.card.resolved")); onResolved?.(); }
    catch (e) { toast.error((e as Error).message || t("experts.card.submitFailed")); }
    finally { setBusy(false); }
  }
  async function forward(toUserId: string) {
    if (busy) return;
    setBusy(true);
    try { await api.agents.forwardEscalation(id, toUserId); toast.success(t("experts.card.forwarded")); onForwarded?.(); }
    catch (e) { toast.error((e as Error).message || t("experts.card.forwardFailed")); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="font-medium text-amber-700">{t("experts.card.title")}</div>
      <div className="mt-1 text-muted">{t("experts.card.background")}</div>
      <div className="whitespace-pre-wrap text-fg">{background}</div>
      <div className="mt-1 text-muted">{t("experts.card.question")}</div>
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
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("experts.card.draftPlaceholder")}
          className="flex-1 rounded-lg border border-line px-2 py-1 outline-none" disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void resolve(draft); } }} />
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void resolve(draft)}
          className="rounded-lg bg-primary px-3 py-1 text-primary-fg disabled:opacity-50">{t("experts.card.decide")}</button>
        <button type="button" disabled={busy} onClick={() => openForward()}
          className="rounded-lg border border-line px-3 py-1 text-fg hover:bg-surface">{t("experts.card.forward")}</button>
      </div>

      {forwarding && (
        <div className="mt-2">
          <div className="mb-1 text-xs text-muted">{t("experts.card.forwardTo")}</div>
          <UserPicker suggestions={members} value={null} onChange={(uid) => { if (uid) void forward(uid); }} />
        </div>
      )}
    </div>
  );
}
