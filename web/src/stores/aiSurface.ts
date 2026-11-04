import { create } from "zustand";

// Tiny global flag to suppress the floating assistant chat surface (AiBubble +
// its composer/input) on pages that already present their own chat-styled
// content and where a second, unrelated "chat with assistant" input would be
// confusing — e.g. the automation run-detail view (running or completed),
// which renders a synthesized 提示词/产出 conversation you can't reply to.
//
// Kept separate from the chat store (which owns real conversation state) so a
// page component can flip it on mount / off on unmount without prop-drilling
// through WorkspaceShell to reach the sibling AiBubble. Mirrors the
// useUnsavedGuard pattern.
interface AiSurfaceState {
  /** When true, AiBubble renders nothing (no bubble, no composer). */
  suppressed: boolean;
  setSuppressed: (v: boolean) => void;
}

export const useAiSurface = create<AiSurfaceState>((set) => ({
  suppressed: false,
  setSuppressed: (v) => set({ suppressed: v }),
}));
