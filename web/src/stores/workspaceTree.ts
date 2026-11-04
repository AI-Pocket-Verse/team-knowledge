import { create } from "zustand";

// Cross-component signal for "refresh the left rail's tree for a role".
//
// The left rail (WorkspaceLeftRail) and the routed pages live as
// siblings under WorkspaceShell, so a page that creates a doc outside
// the rail's own dialogs (e.g. saving a meeting summary as a draft
// article) has no prop path back to the rail. This store is the
// decoupled bridge: the page calls `requestRoleRefresh(roleId)`, the
// rail subscribes and refetches that role's subtree.
//
// `nonce` makes a repeat refresh of the SAME role still fire the rail's
// effect — without it, two saves into one role wouldn't re-trigger.
interface WorkspaceTreeState {
  nonce: number;
  roleId: string | null;
  requestRoleRefresh: (roleId: string) => void;
}

export const useWorkspaceTree = create<WorkspaceTreeState>((set) => ({
  nonce: 0,
  roleId: null,
  requestRoleRefresh: (roleId) =>
    set((s) => ({ nonce: s.nonce + 1, roleId })),
}));
