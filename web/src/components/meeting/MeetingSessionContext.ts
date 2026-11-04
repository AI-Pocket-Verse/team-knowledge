import { createContext, useContext } from "react";
import type { MeetingDetailResponse } from "@team-knowledge/shared";
import type { useMeetingWS } from "./useMeetingWS";
import type { AudioUpload } from "./useAudioUpload";

// The live meeting session, owned by the shell-level MeetingSessionHost and
// consumed by MeetingRoomPage (+ the floating RecordingPill). Because the host
// outlives the routed page, the WS + mic survive in-app navigation.
export interface MeetingSessionValue {
  meetingId: string;
  detail: MeetingDetailResponse | null;
  error: string | null;
  reload: () => Promise<void>;
  isLive: boolean;
  ws: ReturnType<typeof useMeetingWS>;
  audio: AudioUpload;
  /** True while the mic is actively capturing (recording or muted). */
  isRecording: boolean;
  ending: boolean;
  hardDeleting: boolean;
  consentOpen: boolean;
  setConsentOpen: (v: boolean) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  toggleMute: () => void;
  endMeeting: () => Promise<void>;
  hardDeleteMeeting: () => Promise<void>;
}

export const MeetingSessionContext = createContext<MeetingSessionValue | null>(null);

/** Null when there is no active meeting session (no one entered a room yet). */
export function useMeetingSessionContext(): MeetingSessionValue | null {
  return useContext(MeetingSessionContext);
}
