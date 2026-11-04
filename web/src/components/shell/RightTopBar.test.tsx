import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RightTopBar } from "./RightTopBar";
import { usePageChromeStore } from "@/stores/pageChrome";
import { useChatStore } from "@/stores/chat";

// 顶栏右侧三个交互组件依赖 store/网络,这里 stub 成占位,只测左侧标题逻辑。
vi.mock("@/components/shell/HeaderSearch", () => ({ HeaderSearch: () => <div data-testid="search" /> }));
vi.mock("@/components/shell/NotificationBell", () => ({ NotificationBell: () => <div data-testid="bell" /> }));
vi.mock("@/components/shell/UserMenu", () => ({ UserMenu: () => <div data-testid="user" /> }));

describe("RightTopBar", () => {
  beforeEach(() => {
    usePageChromeStore.setState({ chrome: null });
    useChatStore.setState({ conversationId: null, conversations: [], activeTitle: null, activeIsFeishu: false });
  });

  it("AI 落地页 / 无当前会话:顶栏不显示「AI」标题(中央已有大标题)", () => {
    render(<MemoryRouter initialEntries={["/"]}><RightTopBar /></MemoryRouter>);
    expect(screen.queryByText("AI")).toBeNull();
    expect(screen.getByTestId("user")).toBeTruthy(); // 右侧交互区照常渲染
  });

  it("进入具体会话:显示会话标题(与左栏列表一致),不再显示 AI", () => {
    useChatStore.setState({
      conversationId: "c1",
      conversations: [{ id: "c1", title: "需求拆解", isFeishu: false, pinned: false, lastMessageAt: null, createdAt: "x" }],
    });
    render(<MemoryRouter initialEntries={["/c/c1"]}><RightTopBar /></MemoryRouter>);
    expect(screen.getByText("需求拆解")).toBeTruthy();
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("飞书会话:显示「飞书对话」", () => {
    useChatStore.setState({
      conversationId: "f",
      conversations: [{ id: "f", title: null, isFeishu: true, pinned: false, lastMessageAt: null, createdAt: "x" }],
    });
    render(<MemoryRouter initialEntries={["/c/f"]}><RightTopBar /></MemoryRouter>);
    expect(screen.getByText("飞书对话")).toBeTruthy();
  });

  it("pageChrome 面包屑优先于路由兜底", () => {
    usePageChromeStore.setState({ chrome: { breadcrumb: [{ label: "产品" }, { label: "文档A" }] } });
    render(<MemoryRouter initialEntries={["/d/x"]}><RightTopBar /></MemoryRouter>);
    expect(screen.getByText("产品")).toBeTruthy();
    expect(screen.getByText("文档A")).toBeTruthy();
  });
});
