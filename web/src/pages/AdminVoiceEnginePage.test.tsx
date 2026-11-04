import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AdminVoiceEnginePage } from "./AdminVoiceEnginePage";

const getVolcStt = vi.fn();
const getVolcTts = vi.fn();
const saveVolcStt = vi.fn();
const saveVolcTts = vi.fn();
const clearVolcStt = vi.fn();
const clearVolcTts = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    adminSettings: {
      getVolcStt: (...a: unknown[]) => getVolcStt(...a),
      getVolcTts: (...a: unknown[]) => getVolcTts(...a),
      saveVolcStt: (...a: unknown[]) => saveVolcStt(...a),
      saveVolcTts: (...a: unknown[]) => saveVolcTts(...a),
      clearVolcStt: (...a: unknown[]) => clearVolcStt(...a),
      clearVolcTts: (...a: unknown[]) => clearVolcTts(...a),
    },
  },
  ApiError: class extends Error { status = 0 },
}));

let mockIsAdmin = true;
vi.mock("@/stores/auth", () => ({ useIsAdmin: () => mockIsAdmin }));
vi.mock("@/components/Dialog", () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));

beforeEach(() => {
  mockIsAdmin = true;
  getVolcStt.mockReset();
  getVolcTts.mockReset();
  saveVolcStt.mockReset();
  saveVolcTts.mockReset();
  clearVolcStt.mockReset();
  clearVolcTts.mockReset();
  getVolcStt.mockResolvedValue({ configured: false, appId: null, accessToken: null, apiKey: null, endpoint: null, resourceId: null, model: null, boostingTableId: null });
  getVolcTts.mockResolvedValue({ configured: false, appId: null, accessToken: null, apiKey: null, voice: null, endpoint: null });
});

describe("AdminVoiceEnginePage", () => {
  it("non-admin is redirected and never fires the admin API calls", async () => {
    mockIsAdmin = false;
    const { container } = render(
      <MemoryRouter initialEntries={["/admin/voice"]}>
        <Routes>
          <Route path="/admin/voice" element={<AdminVoiceEnginePage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent).toContain("home"));
    expect(getVolcStt).not.toHaveBeenCalled();
    expect(getVolcTts).not.toHaveBeenCalled();
  });

  it("renders 火山 STT + TTS sections + reports 'not configured' by default", async () => {
    render(<MemoryRouter><AdminVoiceEnginePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("实时语音识别 (STT)")).toBeInTheDocument());
    expect(screen.getByText("语音合成 (TTS)")).toBeInTheDocument();
    expect(screen.getAllByText(/未配置/).length).toBeGreaterThanOrEqual(2);
  });

  it("STT save calls api.adminSettings.saveVolcStt with the form values", async () => {
    saveVolcStt.mockResolvedValue({ ok: true });
    render(<MemoryRouter><AdminVoiceEnginePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("实时语音识别 (STT)")).toBeInTheDocument());

    const sttSection = screen.getByText("实时语音识别 (STT)").closest("div")!.parentElement!;
    const inputs = sttSection.querySelectorAll("input");
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "test-app" } });
    fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: "test-token" } });
    getVolcStt.mockResolvedValueOnce({ configured: true, apiKey: "", appId: "test-app", accessToken: "test-token", endpoint: null, resourceId: null, model: null, boostingTableId: null });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => expect(saveVolcStt).toHaveBeenCalledWith({
      apiKey: "", appId: "test-app", accessToken: "test-token", endpoint: null, resourceId: null, model: null, boostingTableId: null,
    }));
  });

  it("STT 只填 API Key(新版控制台)即可保存", async () => {
    saveVolcStt.mockResolvedValue({ ok: true });
    render(<MemoryRouter><AdminVoiceEnginePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("实时语音识别 (STT)")).toBeInTheDocument());
    const sttSection = screen.getByText("实时语音识别 (STT)").closest("div")!.parentElement!;
    const inputs = sttSection.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "my-api-key" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => expect(saveVolcStt).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "my-api-key", appId: "", accessToken: "" })));
  });
});
