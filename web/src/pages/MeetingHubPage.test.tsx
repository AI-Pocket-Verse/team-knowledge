import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MeetingHubPage } from "./MeetingHubPage";
import { usePageChromeStore } from "@/stores/pageChrome";
import { setCurrentLang } from "@/i18n/lang";

// 「新会议」现登记到右区顶栏(usePageChrome),页面本体不再渲染它。测试里没有真实
// 顶栏,用这个小消费组件把登记的 rightActions 渲染出来断言(与 RightTopBar 一致)。
function ChromeActions() {
  const chrome = usePageChromeStore((s) => s.chrome);
  return <>{chrome?.rightActions}</>;
}

// auth store: toggled per-test via mockReturnValueOnce / default.
vi.mock("@/stores/auth", () => ({
  useIsAdmin: vi.fn(() => false),
}));

vi.mock("@/lib/api", () => ({
  api: {
    meeting: {
      hub: vi.fn(),
    },
  },
}));

function activeMeeting(id: string, title: string) {
  return {
    id,
    title,
    status: "active" as const,
    visibility: "public" as const,
    hostUserId: "u1",
    hostName: "张三",
    allowedRoleIds: ["r1"],
    allowedRoles: [{ id: "r1", name: "产品", color: "#8b5cf6" }],
    config: {
      tts: true, recording: true, freqLimitMinutes: 5, triggerSilence: true,
      triggerKeyword: true, durationHintHours: 4, style: "neutral" as const,
    },
    createdAt: new Date(Date.now() - 1000 * 60 * 47).toISOString(),
    endedAt: null,
    recordingUrl: null,
    summaryMarkdown: null,
  };
}
function endedMeeting(id: string, title: string) {
  return {
    ...activeMeeting(id, title),
    status: "ended" as const,
    endedAt: new Date().toISOString(),
  };
}

describe("MeetingHubPage", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("shows empty-state when no meetings exist", async () => {
    const { api } = await import("@/lib/api");
    (api.meeting.hub as ReturnType<typeof vi.fn>).mockResolvedValue({ active: [], recent: [] });
    render(<MemoryRouter><MeetingHubPage /><ChromeActions /></MemoryRouter>);
    expect(await screen.findByText(/还没有任何会议记录/)).toBeInTheDocument();
  });

  it("renders active + recent meetings; admin sees 新会议", async () => {
    const { api } = await import("@/lib/api");
    const { useIsAdmin } = await import("@/stores/auth");
    (useIsAdmin as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (api.meeting.hub as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: [activeMeeting("m1", "V2 评审")],
      recent: [endedMeeting("m0", "上周架构周会")],
    });
    render(<MemoryRouter><MeetingHubPage /><ChromeActions /></MemoryRouter>);
    expect(await screen.findByText("V2 评审")).toBeInTheDocument();
    expect(screen.getByText("上周架构周会")).toBeInTheDocument();
    expect(screen.getByText("新会议")).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
  });

  it("shows 新会议 to non-admins too (creation is open to all)", async () => {
    const { api } = await import("@/lib/api");
    const { useIsAdmin } = await import("@/stores/auth");
    (useIsAdmin as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (api.meeting.hub as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: [activeMeeting("m1", "V2 评审")],
      recent: [],
    });
    render(<MemoryRouter><MeetingHubPage /><ChromeActions /></MemoryRouter>);
    await screen.findByText("V2 评审");
    expect(screen.getByText("新会议")).toBeInTheDocument();
  });

  it("flags private meetings with a 🔒 badge", async () => {
    const { api } = await import("@/lib/api");
    (api.meeting.hub as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: [{ ...activeMeeting("m1", "私密会"), visibility: "private" as const }],
      recent: [],
    });
    render(<MemoryRouter><MeetingHubPage /><ChromeActions /></MemoryRouter>);
    await screen.findByText("私密会");
    expect(screen.getByText("私密")).toBeInTheDocument();
  });

  it("renders English copy when the language is en", async () => {
    setCurrentLang("en");
    try {
      const { api } = await import("@/lib/api");
      (api.meeting.hub as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: [activeMeeting("m1", "V2 review")],
        recent: [],
      });
      render(<MemoryRouter><MeetingHubPage /><ChromeActions /></MemoryRouter>);
      await screen.findByText("V2 review");
      expect(screen.getByText("New meeting")).toBeInTheDocument();
      expect(screen.getByText("Past meetings")).toBeInTheDocument();
      expect(screen.getByText("Enter room →")).toBeInTheDocument();
    } finally {
      setCurrentLang("zh");
    }
  });
});
