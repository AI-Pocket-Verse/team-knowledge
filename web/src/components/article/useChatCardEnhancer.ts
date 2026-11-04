import { useEffect } from "react";
import { toast } from "@/components/Toaster";
import { CHAT_CARD_USER_LABEL, CHAT_CARD_ASSISTANT_PREFIX } from "@/components/chat/chatCardLabels";
import { tr } from "@/i18n";

// (Issue 4) Read-view enhancement for chat-export docs. buildShareMarkdown
// writes each selected message as a blockquote whose FIRST line is the
// role label (🙋 用户 / 🤖 assistant). Here, on the READ-ONLY article view,
// we find those blockquotes, style them as chat cards, and inject a
// per-card 复制 button.
//
// Why DOM-side and not a Milkdown node: Crepe's commonmark `html` node
// renders raw HTML as escaped text (not DOM), so card markup can't be
// embedded in the markdown itself. The read view is static (no editor
// transactions), so enhancing its DOM is stable. It runs ONLY here — the
// editor (ArticleEditPage) never calls this hook, so we never mutate an
// editable ProseMirror surface. Archived docs (what chat exports become)
// have no 编辑 affordance, so they're only ever seen through this view.
//
// Crepe mounts the editor asynchronously, so the blockquotes don't exist
// at first paint — a MutationObserver re-scans until they appear, and the
// `dataset.tmCard` guard keeps every pass idempotent (incl. the observer
// firing on our own injected nodes).
export function useChatCardEnhancer(enabled: boolean, deps: unknown[]) {
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;

    const scan = () => {
      const pm = document.querySelector(".tm-editor .ProseMirror");
      if (!pm) return;
      pm.querySelectorAll<HTMLElement>("blockquote").forEach((bq) => {
        if (bq.dataset.tmCard) return; // already processed
        const firstP = bq.querySelector("p");
        const labelText = (firstP?.textContent ?? "").trim();
        let role: "user" | "ai" | null = null;
        if (labelText.startsWith(CHAT_CARD_USER_LABEL)) role = "user";
        else if (labelText.startsWith(CHAT_CARD_ASSISTANT_PREFIX)) role = "ai";
        if (!role || !firstP) return;

        // Mark BEFORE mutating so the observer's reaction to our own DOM
        // writes below is a no-op on re-scan.
        bq.dataset.tmCard = role;
        bq.classList.add("tm-chat-card", role === "user" ? "tm-chat-card--user" : "tm-chat-card--ai");
        firstP.classList.add("tm-chat-card__label");

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tm-chat-card__copy";
        btn.textContent = tr("common.copy");
        btn.contentEditable = "false";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Copy the body only — drop the label line and the button itself.
          const clone = bq.cloneNode(true) as HTMLElement;
          clone.querySelector(".tm-chat-card__copy")?.remove();
          clone.querySelector(".tm-chat-card__label")?.remove();
          const text = (clone.textContent ?? "").trim();
          void navigator.clipboard.writeText(text).then(
            () => toast.success(tr("common.copied")),
            () => toast.error(tr("article.chatCard.copyFailed")),
          );
        });
        bq.appendChild(btn);
      });
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; scan(); });
    };

    schedule();
    // Observe the editor wrapper (stable; exists before .ProseMirror does)
    // so we catch Crepe's async mount and any later re-render.
    const container = document.querySelector(".tm-editor") ?? document.body;
    const obs = new MutationObserver(schedule);
    obs.observe(container, { childList: true, subtree: true });
    // Belt-and-braces for the common async-mount timing.
    const retry = window.setTimeout(scan, 400);

    return () => {
      obs.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(retry);
      // Revert our DOM mutations. The editor is mounted once and hot-toggles
      // readOnly; if a doc goes read-only → editable (e.g. another user's lock
      // is released and this viewer acquires it), this cleanup runs on the
      // readOnly dep flip and MUST undo the injected 复制 button, card classes,
      // and the contentEditable island — otherwise they linger in the now-
      // editable ProseMirror surface and break the caret inside those
      // blockquotes (the very bug read-only gating was meant to prevent).
      // Idempotent: only touches blockquotes we marked with data-tm-card.
      const pm = document.querySelector(".tm-editor .ProseMirror");
      pm?.querySelectorAll<HTMLElement>("blockquote[data-tm-card]").forEach((bq) => {
        bq.querySelector(".tm-chat-card__copy")?.remove();
        bq.classList.remove("tm-chat-card", "tm-chat-card--user", "tm-chat-card--ai");
        bq.querySelector(".tm-chat-card__label")?.classList.remove("tm-chat-card__label");
        delete bq.dataset.tmCard;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
