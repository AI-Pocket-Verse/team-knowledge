import { useEffect } from "react";
import { create } from "zustand";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastStore {
  items: ToastItem[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

// Most bubbles we keep on screen at once. A flapping error (e.g. a
// retry loop firing toast.error every tick) would otherwise stack
// dozens of bubbles; once we hit the cap we drop the oldest.
const MAX_VISIBLE = 4;

// Tiny zustand store — picking this over a context+reducer keeps the
// public API (`toast.success(...)`) trivially callable from anywhere
// without dragging in a Provider or hook subscription.
const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (kind, message) =>
    set((s) => {
      // Dedupe an identical consecutive message: a repeated error
      // (same kind + text) shouldn't stack — it's the same ack. The
      // existing bubble's own 2.5s timer keeps running, so the latest
      // occurrence still extends visibility naturally on the next tick.
      const last = s.items[s.items.length - 1];
      if (last && last.kind === kind && last.message === message) return s;
      const next = [...s.items, { id: Date.now() + Math.random(), kind, message }];
      // Cap the stack: drop oldest beyond MAX_VISIBLE.
      return { items: next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next };
    }),
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (message: string) => useToastStore.getState().push("success", message),
  error: (message: string) => useToastStore.getState().push("error", message),
  info: (message: string) => useToastStore.getState().push("info", message),
};

const KIND_STYLE: Record<ToastKind, string> = {
  success: "bg-emerald-50 border-emerald-200 text-emerald-800",
  error: "bg-red-50 border-red-200 text-red-700",
  info: "bg-blue-50 border-blue-200 text-blue-800",
};
const KIND_GLYPH: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "ⓘ",
};

function ToastBubble({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  // Each toast self-dismisses after 2.5s. Hovering doesn't pause —
  // these are short ack messages, not anything the reader needs to
  // study. Clicking anywhere on the bubble also dismisses.
  useEffect(() => {
    const t = window.setTimeout(() => onDismiss(item.id), 2500);
    return () => window.clearTimeout(t);
  }, [item.id, onDismiss]);
  return (
    <div
      role="status"
      onClick={() => onDismiss(item.id)}
      className={
        "pointer-events-auto flex min-w-[200px] max-w-sm cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-md " +
        KIND_STYLE[item.kind]
      }
    >
      <span aria-hidden className="shrink-0 font-semibold">{KIND_GLYPH[item.kind]}</span>
      <span className="min-w-0 break-words">{item.message}</span>
    </div>
  );
}

/**
 * Mounted once at the app root. Renders the toast stack in a fixed,
 * top-right column above all other UI. z-[70] sits ABOVE modal dialogs
 * (z-[60] in Dialog.tsx / RoleSkillPanel.tsx) so an ack toast fired from
 * inside a modal — e.g. "已是最新,无需重新生成" — shows on top of the
 * dialog instead of being dimmed behind its backdrop. Pointer-events-none
 * on the container so the area not covered by bubbles doesn't intercept
 * clicks meant for the page underneath.
 */
export function Toaster() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-[70] flex flex-col items-end gap-2">
      {items.map((item) => (
        <ToastBubble key={item.id} item={item} onDismiss={dismiss} />
      ))}
    </div>
  );
}
