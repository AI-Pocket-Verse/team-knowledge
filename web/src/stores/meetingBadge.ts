import { create } from "zustand";

// Cross-component signal for "re-check the left rail's '助手会议' active-
// meeting badge NOW" instead of waiting for its slow 90s poll.
//
// The left rail (WorkspaceLeftRail) shows a pulsing red dot while any meeting
// is live. It polls `api.meeting.hasActive()` every 90s, so after a host stops
// or hard-deletes a meeting the dot lingers for up to a minute. Those actions
// live in MeetingRoomPage — a sibling under WorkspaceShell with no prop path
// back to the rail. This store is the decoupled bridge (same shape as
// useWorkspaceTree): the page calls `refresh()`, the rail re-fetches on the
// `nonce` change.
//
// `nonce` (rather than a boolean) makes a repeat signal still re-trigger the
// rail's effect — e.g. ending two meetings in a row.
interface MeetingBadgeState {
  nonce: number;
  refresh: () => void;
}

export const useMeetingBadge = create<MeetingBadgeState>((set) => ({
  nonce: 0,
  refresh: () => set((s) => ({ nonce: s.nonce + 1 })),
}));
