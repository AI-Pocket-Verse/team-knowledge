import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { MeetingDetailResponse } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { dialog } from "@/components/Dialog";
import { useMeetingBadge } from "@/stores/meetingBadge";
import { useMeetingSession } from "@/stores/meetingSession";
import { useMeetingWS } from "./useMeetingWS";
import { useAudioUpload } from "./useAudioUpload";
import { useBeforeUnloadWhileRecording } from "./useBeforeUnloadWhileRecording";
import { MeetingSessionContext, type MeetingSessionValue } from "./MeetingSessionContext";
import { RecordingPill } from "./RecordingPill";
import { getAssistantName } from "@/lib/assistantName";
import { tr } from "@/i18n";

// Shell-level owner of the live meeting session (mic capture + WebSocket +
// meeting detail). Mounted ABOVE the routed <Outlet/> in WorkspaceShell, so it
// outlives MeetingRoomPage: navigating to another in-app page keeps recording
// alive (the page unmounts, this host doesn't). Driven entirely by
// useMeetingSession().activeMeetingId; MeetingRoomPage just reads the context.
export function MeetingSessionHost({ children }: { children: ReactNode }) {
  const activeMeetingId = useMeetingSession((s) => s.activeMeetingId);
  const leave = useMeetingSession((s) => s.leave);
  const navigate = useNavigate();

  const [detail, setDetail] = useState<MeetingDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [hardDeleting, setHardDeleting] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!activeMeetingId) return;
    try {
      setDetail(await api.meeting.get(activeMeetingId));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setError(tr("meeting.host.notFound"));
      else setError((e as Error).message);
    }
  }, [activeMeetingId]);

  // Re-fetch when the active meeting changes; clear when leaving.
  useEffect(() => {
    if (!activeMeetingId) { setDetail(null); setError(null); return; }
    setDetail(null);
    setError(null);
    void reload();
  }, [activeMeetingId, reload]);

  const isLive = detail?.session.status === "active";
  // Only hold the WS while the session is live; an ended room is a static
  // summary view. useMeetingWS handles null (no connection) + reconnect on id
  // change, so calling it unconditionally is safe.
  const ws = useMeetingWS(
    activeMeetingId && isLive ? activeMeetingId : null,
    detail?.transcripts ?? [],
    detail?.comments ?? [],
  );
  const audio = useAudioUpload({ onChunk: ws.sendBinary, onError: (m) => toast.error(m) });
  const isRecording = audio.state.status === "recording" || audio.state.status === "muted";

  async function startRecording() {
    setConsentOpen(false);
    const ok = await audio.start();
    if (ok) ws.sendText({ type: "mic_state", muted: false });
  }
  function stopRecording() {
    audio.stop();
    ws.sendText({ type: "recording_stopped" });
  }
  function toggleMute() {
    const next = audio.state.status !== "muted";
    audio.setMuted(next);
    ws.sendText({ type: "mic_state", muted: next });
  }

  async function endMeeting() {
    if (!activeMeetingId) return;
    const ok = await dialog.confirm(tr("meeting.host.endBody", { name: getAssistantName() }), {
      title: tr("meeting.host.endTitle"), confirmText: tr("meeting.host.endConfirm"), danger: true,
    });
    if (!ok) return;
    setEnding(true);
    if (isRecording) audio.stop(); // release mic immediately (clears the OS LED)
    try {
      await api.meeting.end(activeMeetingId);
      useMeetingBadge.getState().refresh();
      toast.success(tr("meeting.host.ended"));
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEnding(false);
    }
  }

  async function hardDeleteMeeting() {
    if (!activeMeetingId) return;
    const ok = await dialog.confirm(tr("meeting.host.deleteBody"), {
      title: tr("meeting.host.deleteTitle"), confirmText: tr("common.delete"), danger: true,
    });
    if (!ok) return;
    setHardDeleting(true);
    try {
      await api.meeting.hardDelete(activeMeetingId);
      useMeetingBadge.getState().refresh();
      toast.success(tr("meeting.host.deleted"));
      leave();
      navigate("/meeting");
    } catch (e) {
      toast.error((e as Error).message);
      setHardDeleting(false);
    }
  }

  // Reload to flip into the summary view when the server ends the session
  // (host stopped, admin ended, or the server's hard cap fired).
  useEffect(() => {
    if (ws.state.sessionEnded && !ending) void reload();
  }, [ws.state.sessionEnded, ending, reload]);

  // Belt-and-suspenders: any path that takes the meeting out of `active` must
  // release the host's mic.
  useEffect(() => {
    if (!isLive && isRecording) audio.stop();
  }, [isLive, isRecording, audio]);

  // Warn before unloading the recording window (accidental tab close / reload /
  // navigating to a non-team-knowledge URL would kill the in-progress recording).
  // In-app navigation within team-knowledge is client-side routing — it never unloads
  // the page, so the recording keeps running there without any prompt.
  useBeforeUnloadWhileRecording(isRecording);

  const value: MeetingSessionValue | null = activeMeetingId
    ? {
        meetingId: activeMeetingId, detail, error, reload, isLive: Boolean(isLive), ws, audio,
        isRecording, ending, hardDeleting, consentOpen, setConsentOpen,
        startRecording, stopRecording, toggleMute, endMeeting, hardDeleteMeeting,
      }
    : null;

  return (
    <MeetingSessionContext.Provider value={value}>
      {children}
      <RecordingPill />
    </MeetingSessionContext.Provider>
  );
}
