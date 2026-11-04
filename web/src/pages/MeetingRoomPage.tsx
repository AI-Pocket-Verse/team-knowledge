import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/stores/auth";
import { useMeetingSession } from "@/stores/meetingSession";
import { useMeetingSessionContext, type MeetingSessionValue } from "@/components/meeting/MeetingSessionContext";
import { toast } from "@/components/Toaster";
import { DelayedLoader } from "@/components/DelayedLoader";
import { LiveTranscript } from "@/components/meeting/LiveTranscript";
import { AssistantPanel } from "@/components/meeting/AssistantPanel";
import { useAssistantTtsQueue } from "@/components/meeting/useAssistantTtsQueue";
import { MeetingSummary } from "@/components/meeting/MeetingSummary";
import { cn } from "@/lib/cn";
import { fmtDateTime } from "@/lib/relativeTime";
import { getAssistantName } from "@/lib/assistantName";
import { useT } from "@/i18n";

// Meeting room VIEW. The live session itself (mic capture + WebSocket + meeting
// detail + controls) lives in the shell-level MeetingSessionHost so it survives
// navigating to other in-app pages while recording. This page just registers
// the active meeting and renders the host's context.
export function MeetingRoomPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUser = useAuth((s) => s.user);
  const isAdmin = Boolean(currentUser?.isAdmin);
  const enter = useMeetingSession((s) => s.enter);
  const leave = useMeetingSession((s) => s.leave);
  const mss = useMeetingSessionContext();

  // Register this meeting as active → the host connects + drives the hooks.
  useEffect(() => { if (id) enter(id); }, [id, enter]);

  // On unmount, leave ONLY if we're not recording. While recording, keep the
  // session alive (the floating pill takes over) so navigating to a doc doesn't
  // cut the mic mid-meeting.
  const recordingRef = useRef(false);
  recordingRef.current = mss?.isRecording ?? false;
  useEffect(() => () => { if (!recordingRef.current) leave(); }, [leave]);

  if (mss?.error) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-line bg-surface px-8 py-10 text-center">
        <div className="text-base font-medium text-fg">{mss.error}</div>
        <Link to="/meeting" className="mt-4 inline-block text-sm text-primary underline">
          {t("meeting.room.back")}
        </Link>
      </div>
    );
  }
  // Wait until the host has caught up to THIS meeting and loaded its detail.
  if (!id || !mss || mss.meetingId !== id || !mss.detail) return <DelayedLoader />;

  const { detail, ws, audio, isLive } = mss;
  const { session } = detail;
  const isHost = currentUser?.id === session.hostUserId;
  const canEnd = isHost || isAdmin;
  const micStatus = audio.state.status;
  const isMicOn = mss.isRecording;
  const isMicMuted = micStatus === "muted";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/meeting/${id}`);
      toast.success(t("meeting.room.linkCopied"));
    } catch {
      toast.error(t("meeting.room.copyFailed"));
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-4 -mb-[12px]",
        // Live view: PIN the height so the transcript/assistant panes scroll
        // internally (overflow-y-auto) instead of the whole column growing
        // and pushing page scroll. Summary view: keep min-h so long
        // markdown/transcript grows naturally and `main` scrolls.
        isLive
          ? "h-[calc(100vh-7.5rem+12px)]"
          : "min-h-[calc(100vh-7.5rem+12px)]",
      )}
    >
      <header
        className={
          "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 " +
          (isLive ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50")
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          {isLive ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-700">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
              LIVE
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700">
              {t("meeting.room.ended")}
            </span>
          )}
          <span className="truncate font-semibold">{session.title}</span>
          {isLive && ws.state.status === "open" && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-xs text-muted">
              <span aria-hidden>👁️</span>
              <span>{t("meeting.room.viewers", { n: ws.state.viewerCount })}</span>
            </span>
          )}
          {isLive && !isHost && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
              {t("meeting.room.watching")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isLive && (
            <button
              type="button"
              onClick={() => void copyLink()}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-surface"
            >
              {t("meeting.room.copyLink")}
            </button>
          )}
          {isLive && isHost && !isMicOn && (
            <button
              type="button"
              onClick={() => mss.setConsentOpen(true)}
              disabled={!ws.state || ws.state.status !== "open" || micStatus === "requesting"}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium shadow-glass transition",
                ws.state.status === "open"
                  ? "bg-primary text-primary-fg enabled:hover:bg-primary/90"
                  : "cursor-not-allowed bg-surface text-muted",
              )}
            >
              {micStatus === "requesting" ? t("meeting.room.requestingMic") : t("meeting.room.startRecording")}
            </button>
          )}
          {isLive && isHost && isMicOn && (
            <button
              type="button"
              onClick={mss.stopRecording}
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-100"
            >
              {t("meeting.room.stopRecording")}
            </button>
          )}
          {isLive && canEnd && (
            <button
              type="button"
              onClick={() => void mss.endMeeting()}
              disabled={mss.ending}
              className="rounded-lg bg-rose-500 px-3 py-1.5 text-sm font-medium text-white shadow-glass transition enabled:hover:bg-rose-500/90 disabled:opacity-60"
            >
              {t("meeting.room.endMeeting")}
            </button>
          )}
          {!isLive && (isHost || isAdmin) && (
            <button
              type="button"
              onClick={() => void mss.hardDeleteMeeting()}
              disabled={mss.hardDeleting}
              className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 shadow-glass transition enabled:hover:bg-rose-50 disabled:opacity-60"
            >
              {t("meeting.room.delete")}
            </button>
          )}
        </div>
      </header>

      {/* Meta strip — LIVE only (主持人 + 开始于 + 关联角色). The ended
          summary view drops this row entirely; host + full
          start/end/duration + roles are shown by SummaryMeta in the body. */}
      {isLive && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>{t("meeting.room.host", { name: session.hostName })}</span>
          <span>{t("meeting.room.startedAt", { time: fmtDateTime(session.createdAt) })}</span>
          <span>{t("meeting.room.roles", { roles: session.allowedRoles.map((r) => r.name).join(" / ") || t("meeting.room.none") })}</span>
        </div>
      )}

      {/* No wrapping card here: the body's own panels (transcript / assistant /
          summary sections) carry their own chrome + titles, so an outer
          card just double-framed them and indented their content past the
          header above. Keep only the flex sizing the live view needs for
          internal scrolling. */}
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        {isLive ? (
          <LiveRoomBody
            role={isHost ? "host" : "viewer"}
            ws={ws}
            startedAtMs={new Date(session.createdAt).getTime()}
          />
        ) : (
          <MeetingSummary detail={detail} canArchive={isHost || isAdmin} onRefresh={mss.reload} />
        )}
      </div>

      {isLive && isHost && isMicOn && (
        <HostMicStatusBar audio={audio} isMuted={isMicMuted} onToggleMute={mss.toggleMute} />
      )}

      {mss.consentOpen && (
        <ConsentModal
          onCancel={() => mss.setConsentOpen(false)}
          onConfirm={() => void mss.startRecording()}
        />
      )}
    </div>
  );
}

// ─── Live room body ───────────────────────────────────────────
function LiveRoomBody({ role, ws, startedAtMs }: {
  role: "host" | "viewer";
  ws: MeetingSessionValue["ws"];
  /** Meeting start wall-clock (epoch ms) — passed to the transcript +
   *  assistant panel so their timestamps render as hh:mm rather than offsets. */
  startedAtMs: number;
}) {
  const t = useT();
  const status = ws.state.status;
  const hostConnected = ws.state.hostConnected;
  const hostMicMuted = ws.state.hostMicMuted;
  const isHost = role === "host";

  const [ttsEnabled, setTtsEnabled] = useState(true);
  const tts = useAssistantTtsQueue(ws.state.assistantTtsChunks, isHost && ttsEnabled);

  if (status === "connecting") {
    return <div className="text-center text-muted">{t("meeting.room.connecting")}</div>;
  }
  if (status === "error" || status === "closed") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-center text-muted">
          <div className="text-2xl">⚠️</div>
          <div className="text-fg font-medium">{ws.state.lastError ?? t("meeting.room.disconnected")}</div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-line bg-white px-3 py-1 text-xs text-fg transition hover:bg-surface"
          >
            {t("meeting.room.reload")}
          </button>
        </div>
        {ws.state.transcripts.length > 0 && (
          <LiveTranscript transcripts={ws.state.transcripts} activePartial={null} startedAtMs={startedAtMs} emptyHint="" />
        )}
      </div>
    );
  }

  // Host gets no banner — the「开始录制」button + mic status footer
  // already make the next step obvious, so the hint line is dropped.
  // Viewers still see a status line (waiting / speaking / muted).
  let banner: string | null = t("meeting.room.bannerWaiting");
  if (role === "host") {
    banner = null;
  } else if (hostConnected) {
    banner = hostMicMuted ? t("meeting.room.bannerMuted") : t("meeting.room.bannerSpeaking");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {ws.state.sttDegraded && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("meeting.room.sttDegradedPre")}
          <a href="/admin/voice" className="ml-1 mr-1 underline hover:text-amber-900">{t("meeting.room.sttDegradedLink")}</a>
          {t("meeting.room.sttDegradedPost")}
        </div>
      )}
      {banner && <div className="text-xs text-muted">{banner}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3 lg:grid-rows-1">
        <div className="lg:col-span-2 min-h-0 h-full">
          <LiveTranscript
            transcripts={ws.state.transcripts}
            activePartial={ws.state.activePartial}
            startedAtMs={startedAtMs}
            emptyHint={isHost ? t("meeting.room.hostEmpty") : t("meeting.live.waiting")}
          />
        </div>
        <AssistantPanel
          comments={ws.state.comments}
          startedAtMs={startedAtMs}
          lastSkipped={ws.state.lastAssistantSkipped}
          onAsk={ws.askAssistant}
          isHost={isHost}
          onCommentNow={isHost ? ws.commentNow : undefined}
          ttsEnabled={ttsEnabled}
          onToggleTts={isHost ? setTtsEnabled : undefined}
          playingId={tts.playingId}
          queuedCount={tts.queuedCount}
        />
      </div>
    </div>
  );
}

// ─── Host mic status footer ──────────────────────────────────
function HostMicStatusBar({
  audio,
  isMuted,
  onToggleMute,
}: {
  audio: MeetingSessionValue["audio"];
  isMuted: boolean;
  onToggleMute: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3 shadow-glass">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            isMuted ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700",
          )}>
            {isMuted ? t("meeting.room.micMuted") : t("meeting.room.micRecording")}
          </span>
          <MicLevelMeter level={audio.micLevel} muted={isMuted} />
        </div>
        <button
          type="button"
          onClick={onToggleMute}
          className="rounded-lg border border-line bg-white px-3 py-1 text-xs text-fg transition hover:bg-surface"
        >
          {isMuted ? t("meeting.room.unmute") : t("meeting.room.mute")}
        </button>
      </div>
    </div>
  );
}

function MicLevelMeter({ level, muted }: { level: number; muted: boolean }) {
  const t = useT();
  const segments = 5;
  const active = Math.max(0, Math.min(segments, Math.round((level / 100) * segments)));
  return (
    <div aria-label={t("meeting.room.micLevel")} className="flex items-end gap-0.5">
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "block w-1.5 rounded-sm transition-colors",
            i === 0 ? "h-2" : i === 1 ? "h-3" : i === 2 ? "h-4" : i === 3 ? "h-5" : "h-6",
            muted ? "bg-line" : i < active ? "bg-emerald-500" : "bg-line",
          )}
        />
      ))}
    </div>
  );
}

function ConsentModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-6 shadow-glassLg">
        <div className="text-base font-semibold text-fg">{t("meeting.room.consentTitle")}</div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg/80">
          <li>{t("meeting.room.consent1", { name: getAssistantName() })}</li>
          <li>{t("meeting.room.consent2")}</li>
          <li>{t("meeting.room.consent3")}</li>
          <li>{t("meeting.room.consent4")}</li>
        </ul>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line bg-white px-4 py-1.5 text-sm text-fg transition hover:bg-surface"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-fg shadow-glass transition hover:bg-primary/90 active:scale-95"
          >
            {t("meeting.room.agree")}
          </button>
        </div>
      </div>
    </div>
  );
}
