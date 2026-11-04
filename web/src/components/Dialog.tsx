import { useEffect, useRef } from "react";
import { create } from "zustand";

// Imperative confirm/alert API matching the project's existing
// imperative `toast` pattern (components/Toaster.tsx). One mount in
// the app shell + a singleton store, so any module can fire
// `await dialog.confirm("...")` without dragging in a Provider or
// hook subscription.
//
// Replaces native window.confirm() / window.alert() — the OS dialogs
// don't match the project's macaron-lavender palette and feel out of
// place in an otherwise polished UI. Native dialogs are also sync,
// which prevents the host page from doing optimistic-state updates
// while the user reads the prompt; Promise-based dialogs let the
// caller decide.

interface ConfirmRequest {
  id: number;
  kind: "confirm";
  title?: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface AlertRequest {
  id: number;
  kind: "alert";
  title?: string;
  message: string;
  okText: string;
  resolve: () => void;
}

type DialogRequest = ConfirmRequest | AlertRequest;

interface DialogStore {
  queue: DialogRequest[];
  enqueue: (req: DialogRequest) => void;
  resolveTop: (ok: boolean) => void;
}

const useDialogStore = create<DialogStore>((set, get) => ({
  queue: [],
  enqueue: (req) => set((s) => ({ queue: [...s.queue, req] })),
  resolveTop: (ok) => {
    const top = get().queue[0];
    if (!top) return;
    if (top.kind === "confirm") top.resolve(ok);
    else top.resolve();
    set((s) => ({ queue: s.queue.slice(1) }));
  },
}));

let nextId = 1;

export const dialog = {
  /** Modal confirm with custom-styled OK / Cancel buttons.
   *  Resolves true if the user confirms, false if they cancel
   *  (button, ESC, or backdrop click). */
  confirm(message: string, options?: {
    title?: string;
    confirmText?: string;
    cancelText?: string;
    /** Renders the OK button in danger (red) style. Use for
     *  destructive actions like delete, hard-delete, end meeting. */
    danger?: boolean;
  }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      useDialogStore.getState().enqueue({
        id: nextId++,
        kind: "confirm",
        title: options?.title,
        message,
        confirmText: options?.confirmText ?? "确定",
        cancelText: options?.cancelText ?? "取消",
        danger: options?.danger ?? false,
        resolve,
      });
    });
  },
  /** Modal alert with a single OK button. Resolves when dismissed. */
  alert(message: string, options?: { title?: string; okText?: string }): Promise<void> {
    return new Promise<void>((resolve) => {
      useDialogStore.getState().enqueue({
        id: nextId++,
        kind: "alert",
        title: options?.title,
        message,
        okText: options?.okText ?? "我知道了",
        resolve,
      });
    });
  },
};

/** Mounted once at the app root (alongside Toaster). Renders the
 *  top-of-queue dialog as a centered modal with backdrop. Multiple
 *  queued dialogs render one at a time (next becomes top after the
 *  current resolves). */
export function DialogHost() {
  const top = useDialogStore((s) => s.queue[0] ?? null);
  const resolveTop = useDialogStore((s) => s.resolveTop);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  // Autofocus the primary action on mount so Enter activates it.
  // Tab still works to reach Cancel; Esc resolves with false.
  useEffect(() => {
    if (!top) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveTop(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, resolveTop]);

  if (!top) return null;

  const isDanger = top.kind === "confirm" && top.danger;
  const primaryLabel = top.kind === "confirm" ? top.confirmText : top.okText;
  const showCancel = top.kind === "confirm";

  return (
    <div
      // Backdrop: clicking outside the card cancels (for confirm) or
      // dismisses (for alert). Use mousedown on the backdrop only so
      // a drag that starts inside the card and ends outside doesn't
      // accidentally cancel.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolveTop(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={top.title ? `dlg-title-${top.id}` : undefined}
      aria-describedby={`dlg-msg-${top.id}`}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[1px]"
    >
      <div
        className="w-full max-w-md rounded-xl border border-line bg-white p-6 shadow-xl"
        // Stop the click from bubbling to the backdrop so an
        // inside-card click never triggers cancel.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {top.title && (
          <div id={`dlg-title-${top.id}`} className="mb-2 text-base font-semibold text-fg">
            {top.title}
          </div>
        )}
        <div id={`dlg-msg-${top.id}`} className="text-sm text-fg/80 whitespace-pre-line">
          {top.message}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          {showCancel && (
            <button
              type="button"
              onClick={() => resolveTop(false)}
              className="rounded-md border border-line bg-white px-4 py-1.5 text-sm transition hover:bg-slate-50"
            >
              {(top as ConfirmRequest).cancelText}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={() => resolveTop(true)}
            className={
              "rounded-md px-4 py-1.5 text-sm font-medium shadow-sm transition active:scale-95 " +
              (isDanger
                ? "bg-rose-500 text-white hover:bg-rose-500/90"
                : "bg-primary text-primary-fg hover:bg-primary/90")
            }
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
