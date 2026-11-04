import { create } from "zustand";

// Tracks which meeting the user is currently "in". MeetingRoomPage sets it on
// mount (`enter`) but does NOT clear it on unmount — that's the whole point:
// the mic capture + WebSocket live in a shell-level MeetingSessionHost driven
// by this id, so navigating to another in-app page (产品文档 etc.) keeps the
// recording alive instead of tearing it down with the unmounting page.
//
// The page clears it (`leave`) only on an intentional exit: ending/deleting the
// meeting, returning to the meeting list, or unmounting while NOT recording
// (an idle session has nothing worth preserving).
interface MeetingSessionState {
  activeMeetingId: string | null;
  enter: (id: string) => void;
  leave: () => void;
}

export const useMeetingSession = create<MeetingSessionState>((set) => ({
  activeMeetingId: null,
  enter: (id) => set((s) => (s.activeMeetingId === id ? s : { activeMeetingId: id })),
  leave: () => set((s) => (s.activeMeetingId === null ? s : { activeMeetingId: null })),
}));
