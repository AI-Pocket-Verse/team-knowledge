import { useLocation, useNavigate } from "react-router-dom";
import { useMeetingSessionContext } from "./MeetingSessionContext";
import { useT } from "@/i18n";

// Floating "picture-in-picture call bar". Appears only when the mic is actively
// recording AND the user has navigated AWAY from that meeting's room (e.g. to
// read a doc or open 系统设置) — so a hot mic is never invisible (privacy) and
// the user can stop or jump back without hunting for the meeting. The recording
// host lives above all routes, so this persists across every in-app page.
export function RecordingPill() {
  const t = useT();
  const session = useMeetingSessionContext();
  const location = useLocation();
  const navigate = useNavigate();

  if (!session || !session.isRecording) return null;
  // On the meeting room itself the page already shows the controls.
  if (location.pathname === `/meeting/${session.meetingId}`) return null;

  const muted = session.audio.state.status === "muted";
  return (
    <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-full border border-rose-200 bg-white/95 px-4 py-2 shadow-glassLg backdrop-blur">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-rose-700">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
        {muted ? t("meeting.pill.mutedRecording") : t("meeting.pill.recording")}
      </span>
      <span className="max-w-[160px] truncate text-xs text-muted">
        {session.detail?.session.title ?? t("meeting.pill.defaultTitle")}
      </span>
      <button
        type="button"
        onClick={() => navigate(`/meeting/${session.meetingId}`)}
        className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-fg transition hover:bg-surface"
      >
        {t("meeting.pill.back")}
      </button>
      <button
        type="button"
        onClick={session.stopRecording}
        className="rounded-full bg-rose-500 px-3 py-1 text-xs font-medium text-white transition hover:bg-rose-500/90"
      >
        {t("meeting.pill.stop")}
      </button>
    </div>
  );
}
