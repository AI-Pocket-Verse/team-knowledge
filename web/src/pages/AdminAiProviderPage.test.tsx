import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AdminAiProviderPage } from "./AdminAiProviderPage";

const getLlmProvider = vi.fn();
const setLlmProvider = vi.fn();
const getLlmBinaries = vi.fn();
const setLlmBinaries = vi.fn();
const getModelDisplay = vi.fn();
const setModelDisplay = vi.fn();
const getLlmModels = vi.fn();
const setLlmModels = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    adminSettings: {
      getLlmProvider: (...a: unknown[]) => getLlmProvider(...a),
      setLlmProvider: (...a: unknown[]) => setLlmProvider(...a),
      getLlmBinaries: (...a: unknown[]) => getLlmBinaries(...a),
      setLlmBinaries: (...a: unknown[]) => setLlmBinaries(...a),
      getModelDisplay: (...a: unknown[]) => getModelDisplay(...a),
      setModelDisplay: (...a: unknown[]) => setModelDisplay(...a),
      getLlmModels: (...a: unknown[]) => getLlmModels(...a),
      setLlmModels: (...a: unknown[]) => setLlmModels(...a),
    },
  },
  ApiError: class extends Error { status = 0 },
}));

let mockIsAdmin = true;
vi.mock("@/stores/auth", () => ({ useIsAdmin: () => mockIsAdmin }));

function makeStatus(overrides: { current?: "claude" | "codex"; codexOk?: boolean; codexAllowed?: boolean } = {}) {
  return {
    current: overrides.current ?? "claude",
    codexAllowed: overrides.codexAllowed ?? true,
    available: {
      claude: { ok: true, version: "1.0.0" },
      codex: overrides.codexOk === false ? { ok: false, reason: "not found" } : { ok: true, version: "0.5.0" },
    },
  };
}

beforeEach(() => {
  mockIsAdmin = true;
  getLlmProvider.mockReset();
  setLlmProvider.mockReset();
  getLlmBinaries.mockReset();
  setLlmBinaries.mockReset();
  getModelDisplay.mockReset();
  setModelDisplay.mockReset();
  getLlmModels.mockReset();
  setLlmModels.mockReset();
  getLlmModels.mockResolvedValue({
    claude: null, codex: null,
    envDefault: { claude: null, codex: null },
    active: { claude: null, codex: null },
  });
  // LlmBinariesSection loads on mount — keep it quiet.
  getLlmBinaries.mockResolvedValue({
    claudePath: null, codexPath: null,
    available: { claude: { ok: true, version: "1.0.0" }, codex: { ok: true, version: "0.5.0" } },
  });
  // ModelDisplaySection 同样在挂载时就拉一次 —— 不给它值会在 useEffect 里抛
  // TypeError，整个页面渲染失败，把无关的用例一起带红。
  getModelDisplay.mockResolvedValue({
    claude: { model: "Claude", version: "4.8", level: "high" },
    codex: { model: "Codex", version: "5.6", level: "high" },
    showInGroupCard: false,
    detected: { claude: null, codex: null },
  });
});

describe("AdminAiProviderPage", () => {
  it("non-admin is redirected and never fires the admin API calls", async () => {
    mockIsAdmin = false;
    getLlmProvider.mockResolvedValue(makeStatus());
    const { container } = render(
      <MemoryRouter initialEntries={["/admin/ai-provider"]}>
        <Routes>
          <Route path="/admin/ai-provider" element={<AdminAiProviderPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent).toContain("home"));
    expect(getLlmProvider).not.toHaveBeenCalled();
    expect(getLlmBinaries).not.toHaveBeenCalled();
    expect(getModelDisplay).not.toHaveBeenCalled();
    expect(getLlmModels).not.toHaveBeenCalled();
  });

  it("model section: shows the effective model and saves trimmed ids (empty clears)", async () => {
    getLlmProvider.mockResolvedValue(makeStatus());
    getLlmModels.mockResolvedValue({
      claude: null, codex: null,
      envDefault: { claude: "sonnet", codex: null },
      active: { claude: "sonnet", codex: null },
    });
    setLlmModels.mockResolvedValue({
      claude: "opus", codex: null,
      envDefault: { claude: "sonnet", codex: null },
      active: { claude: "opus", codex: null },
    });
    render(<MemoryRouter><AdminAiProviderPage /></MemoryRouter>);
    const claudeInput = await screen.findByPlaceholderText("留空使用 .env 中的 sonnet");
    const section = screen.getByTestId("llm-models-section");
    expect(within(section).getByText("sonnet")).toBeInTheDocument();
    fireEvent.change(claudeInput, { target: { value: "  opus " } });
    fireEvent.click(within(section).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setLlmModels).toHaveBeenCalledWith({ claude: "opus", codex: null }));
    await waitFor(() => expect(within(section).getByText("opus")).toBeInTheDocument());
  });

  it("model section: shows the server's error message when saving fails", async () => {
    getLlmProvider.mockResolvedValue(makeStatus());
    setLlmModels.mockRejectedValue(new Error("Claude Code 模型 ID 只能包含字母、数字和 . _ - : / [ ]，且以字母或数字开头"));
    render(<MemoryRouter><AdminAiProviderPage /></MemoryRouter>);
    const claudeInput = await screen.findByPlaceholderText("如 opus、sonnet 或完整模型 ID");
    fireEvent.change(claudeInput, { target: { value: "--bad" } });
    fireEvent.click(within(screen.getByTestId("llm-models-section")).getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/模型 ID 只能包含/)).toBeInTheDocument();
  });

  // 「Claude Code」「Codex」这两个字串在页面上不止一处(下方 ModelDisplaySection
  // 也用同样的标签),所以一律用 provider-row-* 锚定到切换区再查,别用裸 getByText。
  it("renders both provider rows + 'current' on claude", async () => {
    getLlmProvider.mockResolvedValue(makeStatus());
    render(<MemoryRouter><AdminAiProviderPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("provider-row-claude")).toBeInTheDocument());
    expect(within(screen.getByTestId("provider-row-claude")).getByText("Claude Code")).toBeInTheDocument();
    expect(within(screen.getByTestId("provider-row-codex")).getByText("Codex")).toBeInTheDocument();
    // 「当前」必须落在 claude 那行 —— 原来取 getAllByText(/当前/)[0] 并不能保证这点。
    expect(within(screen.getByTestId("provider-row-claude")).getByText("当前")).toBeInTheDocument();
  });

  it("disables switch button when target is unavailable", async () => {
    getLlmProvider.mockResolvedValue(makeStatus({ codexOk: false }));
    render(<MemoryRouter><AdminAiProviderPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("provider-row-codex")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /切换为 Codex/ })).toBeDisabled();
  });

  it("multi-user mode: codex switch is disabled with the reason shown", async () => {
    getLlmProvider.mockResolvedValue(makeStatus({ codexAllowed: false }));
    render(<MemoryRouter><AdminAiProviderPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("provider-row-codex")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /切换为 Codex/ })).toBeDisabled();
    expect(within(screen.getByTestId("provider-row-codex")).getByText(/多人部署只能使用 Claude Code/)).toBeInTheDocument();
  });

  it("calls setLlmProvider on click and reflects new current", async () => {
    getLlmProvider.mockResolvedValueOnce(makeStatus());
    setLlmProvider.mockResolvedValue(makeStatus({ current: "codex" }));
    render(<MemoryRouter><AdminAiProviderPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("provider-row-codex")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /切换为 Codex/ }));
    await waitFor(() => expect(setLlmProvider).toHaveBeenCalledWith({ provider: "codex" }));
  });
});
