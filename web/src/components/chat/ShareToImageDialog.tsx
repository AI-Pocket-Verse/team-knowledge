import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessageRow } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { cn } from "@/lib/cn";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT } from "@/i18n";

// Render selected chat messages into a shareable PNG. Sibling of
// ShareToDocDialog: the server lays the turns out as a chat-bubble image
// (reusing the weekly-report SVG→PNG stack) and we preview it here with
// download + copy-to-clipboard. The whole thing is the user's OWN chat, so
// there's no extra permission gate.

const getDefaultTitle = () => tr("chat.share.defaultTitle", { name: getAssistantName() });

// Map selected rows → the API payload. Exported for unit testing.
export function buildChatImagePayload(
  messages: ChatMessageRow[],
  title?: string,
): { title?: string; messages: { role: "user" | "assistant"; content: string; images: string[] }[] } {
  return {
    title: title?.trim() ? title.trim() : undefined,
    messages: messages.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
      images: m.images ?? [],
    })),
  };
}

type Status = "loading" | "ready" | "error";

export function ShareToImageDialog({
  messages, onClose,
}: {
  messages: ChatMessageRow[];
  onClose: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(getDefaultTitle());
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>("");
  const [url, setUrl] = useState<string>("");
  const blobRef = useRef<Blob | null>(null);
  const urlRef = useRef<string>("");

  const revoke = () => {
    if (urlRef.current && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
  };

  const generate = useCallback(async (t: string) => {
    setStatus("loading");
    setError("");
    try {
      const blob = await api.chat.shareImage(buildChatImagePayload(messages, t));
      revoke();
      blobRef.current = blob;
      const next = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
      urlRef.current = next;
      setUrl(next);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setStatus("error");
    }
  }, [messages]);

  // Generate once on open. Regeneration (e.g. after a title edit) is manual.
  useEffect(() => {
    void generate(getDefaultTitle());
    return () => revoke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = () => {
    if (!urlRef.current) return;
    const a = document.createElement("a");
    a.href = urlRef.current;
    a.download = `${(title.trim() || getDefaultTitle())}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const copy = async () => {
    const blob = blobRef.current;
    if (!blob) return;
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error(t("chat.shareImage.copyUnsupported"));
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success(t("chat.shareImage.copied"));
    } catch {
      toast.error(t("chat.shareImage.copyFailed"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-white shadow-glassLg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-base font-semibold text-fg">{t("chat.shareImage.title")}</div>
          <div className="text-xs text-muted">{t("chat.shareImage.selected", { n: messages.length })}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t("chat.shareImage.imageTitle")}</span>
              <div className="flex gap-2">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-primary"
                  placeholder={getDefaultTitle()}
                />
                <button
                  type="button"
                  onClick={() => void generate(title)}
                  disabled={status === "loading"}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-sm transition enabled:hover:bg-surface disabled:opacity-50"
                >
                  {status === "loading" ? t("chat.shareImage.generating") : t("chat.shareImage.regenerate")}
                </button>
              </div>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t("chat.shareImage.preview")}</span>
              <div className="flex min-h-[8rem] items-center justify-center rounded-lg border border-line bg-surface p-2">
                {status === "loading" && <span className="text-xs text-muted">{t("chat.shareImage.generatingImage")}</span>}
                {status === "error" && <span className="text-xs text-rose-600">⚠ {error}</span>}
                {status === "ready" && url && (
                  <img src={url} alt={t("chat.shareImage.previewAlt")} className="max-h-[50vh] w-auto max-w-full rounded-lg shadow-glass" />
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line bg-white px-4 py-1.5 text-sm transition hover:bg-surface"
          >
            {t("common.close")}
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={status !== "ready"}
            className="rounded-lg border border-line bg-white px-4 py-1.5 text-sm transition enabled:hover:bg-surface disabled:opacity-50"
          >
            {t("chat.shareImage.copy")}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={status !== "ready"}
            className={cn(
              "rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-fg shadow-glass transition",
              "enabled:hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {t("chat.shareImage.downloadPng")}
          </button>
        </div>
      </div>
    </div>
  );
}
