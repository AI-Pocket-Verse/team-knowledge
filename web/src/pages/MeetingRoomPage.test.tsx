import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MeetingRoomPage } from "./MeetingRoomPage";
import { MeetingSessionHost } from "@/components/meeting/MeetingSessionHost";
import { useMeetingSession } from "@/stores/meetingSession";

vi.mock("@/stores/auth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error { constructor(m: string, public status: number) { super(m); } },
  API_BASE: "/kb/api",
  api: { meeting: { get: vi.fn(), end: vi.fn() } },
}));

vi.mock("@/components/Toaster", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Dialog is the new custom confirm/alert host. Default both
// confirm() and alert() to resolve permissive so tests that don't
// care about the prompt continue to flow through.
vi.mock("@/components/Dialog", () => ({
  dialog: { confirm: vi.fn().mockResolvedValue(true), alert: vi.fn().mockResolvedValue(undefined) },
  DialogHost: () => null,
}));

// useMeetingWS — stubbed per-test so we can flip role / status
// without spinning up a real WebSocket in jsdom.
const wsMock = vi.fn();
vi.mock("@/components/meeting/useMeetingWS", () => ({
  useMeetingWS: (sessionId: string | null) => wsMock(sessionId),
}));

// useAudioUpload — stubbed so the host UI renders without
// touching getUserMedia / MediaRecorder, which jsdom can't run.
const audioMock = vi.fn();
vi.mock("@/components/meeting/useAudioUpload", () => ({
  useAudioUpload: (opts: unknown) => audioMock(opts),
}));

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      id: "m1",
      title: "V2 评审",
      status: "active",
      hostUserId: "u-admin",
      hostName: "Admin",
      allowedRoleIds: ["r1"],
      allowedRoles: [{ id: "r1", name: "产品", color: "#8b5cf6" }],
      config: {
        tts: true, recording: true, freqLimitMinutes: 5, triggerSilence: true,
        triggerKeyword: true, durationHintHours: 4, style: "neutral",
      },
      createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      endedAt: null,
      recordingUrl: null,
      summaryMarkdown: null,
      ...overrides,
    },
    transcripts: [],
    comments: [],
  };
}

function renderRoom() {
  // The live session now lives in the shell-level MeetingSessionHost; the page
  // is just a view that reads its context. Wrap with the real host so the
  // (mocked) hooks + api drive the provided context.
  return render(
    <MemoryRouter initialEntries={["/meeting/m1"]}>
      <MeetingSessionHost>
        <Routes>
          <Route path="/meeting/:id" element={<MeetingRoomPage />} />
        </Routes>
      </MeetingSessionHost>
    </MemoryRouter>,
  );
}

describe("MeetingRoomPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMeetingSession.getState().leave(); // reset active meeting between tests
    // Default audio hook = idle state (no mic open). Tests override
    // before render where they need a different state.
    audioMock.mockReturnValue({
      state: { status: "idle", error: null },
      micLevel: 0,
      start: vi.fn().mockResolvedValue(true),
      stop: vi.fn(),
      setMuted: vi.fn(),
    });
  });

  it("host sees the start-recording button + viewer count badge once WS opens", async () => {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ user: { id: "u-admin", isAdmin: true } }),
    );
    const { api } = await import("@/lib/api");
    (api.meeting.get as ReturnType<typeof vi.fn>).mockResolvedValue(activeSession());
    wsMock.mockReturnValue({
      state: { status: "open", role: "host", viewerCount: 3, hostConnected: true, hostMicMuted: false, recordingEnabled: true, sessionEnded: false, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: false },
      sendBinary: vi.fn(),
      sendText: vi.fn(),
      askAssistant: vi.fn(),
      commentNow: vi.fn(),
    });

    renderRoom();
    expect(await screen.findByText("V2 评审")).toBeInTheDocument();
    expect(await screen.findByText("🎙️ 开始录制")).toBeInTheDocument();
    expect(screen.getByText("3 围观")).toBeInTheDocument();
    // Host gets NO banner hint line (removed per product) — the
    // 开始录制 button already makes the next step obvious.
    expect(screen.queryByText(/你是主持人/)).not.toBeInTheDocument();
    // Host does NOT see the "你正在围观" badge.
    expect(screen.queryByText("你正在围观")).not.toBeInTheDocument();
  });

  it("viewer sees read-only banner + status reflects host mic state", async () => {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ user: { id: "u-viewer", isAdmin: false } }),
    );
    const { api } = await import("@/lib/api");
    (api.meeting.get as ReturnType<typeof vi.fn>).mockResolvedValue(activeSession());
    wsMock.mockReturnValue({
      state: { status: "open", role: "viewer", viewerCount: 1, hostConnected: true, hostMicMuted: true, recordingEnabled: true, sessionEnded: false, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: false },
      sendBinary: vi.fn(),
      sendText: vi.fn(),
      askAssistant: vi.fn(),
      commentNow: vi.fn(),
    });

    renderRoom();
    expect(await screen.findByText("V2 评审")).toBeInTheDocument();
    expect(await screen.findByText("你正在围观")).toBeInTheDocument();
    // Viewer doesn't get mic controls.
    expect(screen.queryByText("🎙️ 开始录制")).not.toBeInTheDocument();
    // Banner: surfaces the muted state with the 🔇 prefix.
    expect(screen.getByText(/主持人已静音/)).toBeInTheDocument();
  });

  it("ended session: shows summary placeholder + recording URL when present", async () => {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ user: { id: "u-admin", isAdmin: true } }),
    );
    const { api } = await import("@/lib/api");
    (api.meeting.get as ReturnType<typeof vi.fn>).mockResolvedValue(activeSession({
      status: "ended",
      endedAt: new Date().toISOString(),
      recordingUrl: "/meeting-recordings/m1.ogg",
    }));
    wsMock.mockReturnValue({
      state: { status: "closed", role: null, viewerCount: 0, hostConnected: false, hostMicMuted: false, recordingEnabled: true, sessionEnded: false, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: false },
      sendBinary: vi.fn(),
      sendText: vi.fn(),
      askAssistant: vi.fn(),
      commentNow: vi.fn(),
    });

    renderRoom();
    expect(await screen.findByText("V2 评审")).toBeInTheDocument();
    expect(await screen.findByText(/AI 正在生成纪要/)).toBeInTheDocument();
    // Recording surfaces as an <audio> element + a styled 下载 link with
    // the URL in the href; neither renders the URL as plain text.
    expect(screen.getByText("下载录音文件")).toBeInTheDocument();
    // Ended state hides the start-recording / 结束会议 affordances.
    expect(screen.queryByText("🎙️ 开始录制")).not.toBeInTheDocument();
    expect(screen.queryByText("🛑 结束会议")).not.toBeInTheDocument();
  });

  it("host recording state: shows mic-level meter + stop/mute controls", async () => {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ user: { id: "u-admin", isAdmin: true } }),
    );
    const { api } = await import("@/lib/api");
    (api.meeting.get as ReturnType<typeof vi.fn>).mockResolvedValue(activeSession());
    wsMock.mockReturnValue({
      state: { status: "open", role: "host", viewerCount: 0, hostConnected: true, hostMicMuted: false, recordingEnabled: true, sessionEnded: false, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: false },
      sendBinary: vi.fn(),
      sendText: vi.fn(),
      askAssistant: vi.fn(),
      commentNow: vi.fn(),
    });
    audioMock.mockReturnValue({
      state: { status: "recording", error: null },
      micLevel: 42,
      start: vi.fn(),
      stop: vi.fn(),
      setMuted: vi.fn(),
    });

    renderRoom();
    await waitFor(() => expect(screen.getByText("● 录制中")).toBeInTheDocument());
    // Stop-recording is now a header button — its label carries a
    // leading ⏹ emoji, so we match by regex rather than the exact
    // string. The 静音 button below has no decorative prefix, so
    // exact match is still fine for it.
    expect(screen.getByText(/停止录制/)).toBeInTheDocument();
    expect(screen.getByText("静音")).toBeInTheDocument();
    // The meter renders 5 segments
    expect(screen.getByLabelText("麦克风音量").querySelectorAll("span").length).toBe(5);
  });

  it("sttDegraded=true renders the amber 本地模拟转录 banner", async () => {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ user: { id: "u-admin", isAdmin: true } }),
    );
    const { api } = await import("@/lib/api");
    (api.meeting.get as ReturnType<typeof vi.fn>).mockResolvedValue(activeSession());
    wsMock.mockReturnValue({
      state: { status: "open", role: "host", viewerCount: 0, hostConnected: true, hostMicMuted: false, recordingEnabled: true, sessionEnded: false, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: true },
      sendBinary: vi.fn(),
      sendText: vi.fn(),
      askAssistant: vi.fn(),
      commentNow: vi.fn(),
    });

    renderRoom();
    expect(await screen.findByText(/语音识别暂时不可用/)).toBeInTheDocument();
  });

  it("session_ended from WS triggers a re-fetch (page swaps to ended state)", async () => {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ user: { id: "u-admin", isAdmin: true } }),
    );
    const { api } = await import("@/lib/api");
    // First call returns active; second (after WS sessionEnded) returns ended.
    (api.meeting.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(activeSession())
      .mockResolvedValue(activeSession({ status: "ended", endedAt: new Date().toISOString() }));
    wsMock.mockReturnValue({
      state: { status: "closed", role: "host", viewerCount: 0, hostConnected: false, hostMicMuted: false, recordingEnabled: true, sessionEnded: true, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: false },
      sendBinary: vi.fn(),
      sendText: vi.fn(),
      askAssistant: vi.fn(),
      commentNow: vi.fn(),
    });

    renderRoom();
    await waitFor(() => expect(screen.getByText(/AI 正在生成纪要/)).toBeInTheDocument());
    expect(api.meeting.get).toHaveBeenCalledTimes(2);
  });
});

// Locks in the in-app persistence invariant (feature 1): unmounting the room
// (= navigating to another page) must keep the live session alive WHILE
// recording, so the shell host keeps the mic + WS running; an idle room is torn
// down. Uses the REAL useMeetingSession store via the host.
describe("MeetingRoomPage — recording persistence on navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMeetingSession.getState().leave();
    audioMock.mockReturnValue({
      state: { status: "idle", error: null }, micLevel: 0,
      start: vi.fn().mockResolvedValue(true), stop: vi.fn(), setMuted: vi.fn(),
    });
  });

  async function setup(recording: boolean) {
    const { useAuth } = await import("@/stores/auth");
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation((sel: (s: unknown) => unknown) =>
      sel({ user: { id: "u-admin", isAdmin: true } }),
    );
    const { api } = await import("@/lib/api");
    (api.meeting.get as ReturnType<typeof vi.fn>).mockResolvedValue(activeSession());
    wsMock.mockReturnValue({
      state: { status: "open", role: "host", viewerCount: 0, hostConnected: true, hostMicMuted: false, recordingEnabled: true, sessionEnded: false, lastError: null, transcripts: [], activePartial: null, comments: [], assistantTtsChunks: [], lastAssistantSkipped: null, sttDegraded: false },
      sendBinary: vi.fn(), sendText: vi.fn(), askAssistant: vi.fn(), commentNow: vi.fn(),
    });
    if (recording) {
      audioMock.mockReturnValue({
        state: { status: "recording", error: null }, micLevel: 10,
        start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
      });
    }
  }

  it("keeps activeMeetingId set on unmount WHILE recording", async () => {
    await setup(true);
    const { unmount } = renderRoom();
    await screen.findByText("V2 评审");
    unmount();
    expect(useMeetingSession.getState().activeMeetingId).toBe("m1");
  });

  it("clears activeMeetingId on unmount when NOT recording", async () => {
    await setup(false);
    const { unmount } = renderRoom();
    await screen.findByText("V2 评审");
    unmount();
    expect(useMeetingSession.getState().activeMeetingId).toBeNull();
  });
});
