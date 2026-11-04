import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminFeishuTasksPage } from "./AdminFeishuTasksPage";
import { Toaster } from "@/components/Toaster";

// 飞书群任务控制台(原 系统设置 的「飞书群通知」tab,现独立成页)的交互测试。
const notifyTestList = vi.fn();
const notifyTestUpdate = vi.fn();
const notifyTestSend = vi.fn();
const notifyTestSendStatus = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    admin: {
      notifyTest: {
        list: (...a: unknown[]) => notifyTestList(...a),
        update: (...a: unknown[]) => notifyTestUpdate(...a),
        send: (...a: unknown[]) => notifyTestSend(...a),
        sendStatus: (...a: unknown[]) => notifyTestSendStatus(...a),
      },
    },
  },
}));

let mockIsAdmin = true;
vi.mock("@/stores/auth", () => ({ useIsAdmin: () => mockIsAdmin }));

beforeEach(() => {
  mockIsAdmin = true;
  notifyTestList.mockReset();
  notifyTestUpdate.mockReset();
  notifyTestSend.mockReset();
  notifyTestSendStatus.mockReset();
  notifyTestList.mockResolvedValue({ scenarios: [] });
});

function makeNotifyScenario() {
  return {
    key: "weekly_digest",
    title: "每周群周报",
    description: "每周向飞书群发送周报",
    triggerType: "cron" as const,
    schedule: "定时任务：每周五 21:00（北京时间）",
    enabled: true,
    available: [
      { chatId: "c1", name: "群A" },
      { chatId: "c2", name: "群B" },
    ],
    selected: ["c1", "c2"],
    running: false,
    cronSchedule: { weekdays: [5], hour: 21, minute: 0, repeat: true },
  };
}

describe("AdminFeishuTasksPage(飞书群任务)", () => {
  it("非管理员被拦截,不触发任务列表请求", () => {
    mockIsAdmin = false;
    render(<MemoryRouter initialEntries={["/admin/feishu-tasks"]}><AdminFeishuTasksPage /></MemoryRouter>);
    expect(notifyTestList).not.toHaveBeenCalled();
  });

  it("空任务列表:挂载即拉列表并显示占位", async () => {
    render(<MemoryRouter><AdminFeishuTasksPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("暂无通知任务。")).toBeInTheDocument());
    expect(notifyTestList).toHaveBeenCalled();
  });

  it("配置改动只落草稿,点「保存」统一提交并提示成功", async () => {
    const sc = makeNotifyScenario();
    notifyTestList.mockResolvedValue({ scenarios: [sc] });
    notifyTestUpdate.mockResolvedValue({
      scenario: { ...sc, selected: ["c1"], cronSchedule: { weekdays: [1, 5], hour: 21, minute: 0, repeat: true } },
    });
    render(<MemoryRouter><AdminFeishuTasksPage /><Toaster /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText("每周群周报").length).toBeGreaterThan(0));
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled(); // 无改动时不可保存

    fireEvent.click(screen.getByRole("checkbox", { name: /群B/ }));
    fireEvent.click(screen.getByRole("button", { name: "周一" }));
    expect(notifyTestUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("未保存")).toBeInTheDocument();
    expect(saveBtn).toBeEnabled();

    fireEvent.click(saveBtn);
    await waitFor(() => expect(notifyTestUpdate).toHaveBeenCalledWith("weekly_digest", {
      chatIds: ["c1"],
      schedule: { weekdays: [1, 5], hour: 21, minute: 0, repeat: true },
    }));
    expect(notifyTestUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("保存成功")).toBeInTheDocument());
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("保存失败时提示失败,草稿保留可重试", async () => {
    notifyTestList.mockResolvedValue({ scenarios: [makeNotifyScenario()] });
    notifyTestUpdate.mockRejectedValue(new Error("boom"));
    render(<MemoryRouter><AdminFeishuTasksPage /><Toaster /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText("每周群周报").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("checkbox", { name: /群B/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(notifyTestUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/保存失败.*boom/)).toBeInTheDocument());
    expect(screen.getByText("未保存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("顶部标签行:每个任务一个 chip,点击滚到对应卡片", async () => {
    notifyTestList.mockResolvedValue({ scenarios: [makeNotifyScenario()] });
    const scrollSpy = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { value: scrollSpy, configurable: true, writable: true });
    render(<MemoryRouter><AdminFeishuTasksPage /></MemoryRouter>);
    const tab = await screen.findByRole("button", { name: "跳转-每周群周报" });
    fireEvent.click(tab);
    expect(scrollSpy).toHaveBeenCalled();
  });
});
