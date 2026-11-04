import { create } from "zustand";

// Tiny global flag mirroring the article editor's dirty state. The editor
// keeps this in sync; the left rail reads it to intercept in-app navigation
// (document / role / folder links, 新建文档, etc.) with a confirm prompt so a
// stray click can't silently discard unsaved edits. Kept separate from the
// editor's local state so the rail — a sibling, not a child — can subscribe
// without prop-drilling through WorkspaceShell.
interface UnsavedGuardState {
  dirty: boolean;
  setDirty: (v: boolean) => void;
}

export const useUnsavedGuard = create<UnsavedGuardState>((set) => ({
  dirty: false,
  setDirty: (v) => set({ dirty: v }),
}));
