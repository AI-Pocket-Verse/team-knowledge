import { useEffect } from "react";

// While the current window is actively recording, intercept page unload (tab
// close, or same-tab navigation to another app) with the
// browser's native "leave site?" confirm — a full-page unload kills the mic
// stream, so this stops the host from losing a recording by accident. Attach it
// ONLY on the window that owns the live mic (the in-tab host or the popup).
export function useBeforeUnloadWhileRecording(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy requirement: a non-empty returnValue triggers the prompt in some
      // browsers. The actual text is fixed by the browser, not us.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
