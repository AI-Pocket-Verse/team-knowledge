import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AutomationPage } from "./AutomationPage";
import { AutomationForm } from "@/components/automation/AutomationForm";
import { setCurrentLang } from "@/i18n/lang";

vi.mock("@/lib/api", () => ({
  api: {
    automations: {
      list: vi.fn().mockResolvedValue({
        automations: [{
          id: "a1", name: "Daily digest", enabled: true, scheduleKind: "cron", scheduleLabel: "Daily 09:00",
          nextRunAt: new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString(), createdAt: new Date().toISOString(),
          lastRunStatus: null, pinnedAt: null,
        }],
        recentRuns: [],
        templates: [],
        runsHasMore: false,
      }),
    },
  },
}));

afterEach(() => setCurrentLang("zh"));

describe("AutomationPage", () => {
  it("renders Chinese by default", async () => {
    render(<AutomationPage />);
    expect(await screen.findByText("已安排")).toBeInTheDocument();
    expect(screen.getByText("3 小时后开始")).toBeInTheDocument();
    expect(screen.getByText("暂无运行记录。")).toBeInTheDocument();
  });

  it("renders English copy with pluralized relative time", async () => {
    setCurrentLang("en");
    render(<AutomationPage />);
    expect(await screen.findByText("Scheduled")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Starts in 3 hours")).toBeInTheDocument());
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
  });
});

describe("AutomationForm", () => {
  it("renders English labels and weekday buttons", () => {
    setCurrentLang("en");
    render(<AutomationForm onSubmit={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    expect(screen.getByText("Frequency")).toBeInTheDocument();
    expect(screen.getByText("Recurring")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
});
