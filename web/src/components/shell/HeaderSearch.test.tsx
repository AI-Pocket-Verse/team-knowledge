import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { HeaderSearch } from "./HeaderSearch";

vi.mock("@/lib/api", () => ({
  api: { articles: { search: vi.fn(), recentViews: vi.fn() } },
}));

const HIT = { id: "a1", title: "报销流程", folderName: "财务", roleName: "产品", roleColor: "blue" };
const HIT2 = { id: "a2", title: "报销制度", folderName: "财务", roleName: "产品", roleColor: "blue" };
const RECENT = {
  id: "r1",
  title: "最近文档",
  folderId: null,
  folderName: "财务",
  roleId: "role1",
  roleName: "产品",
  roleColor: "blue",
  lastViewedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  editorName: "李四",
};

const HISTORY_KEY = "assistant.searchHistory";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

async function mockedApi() {
  const { api } = await import("@/lib/api");
  return api as unknown as {
    articles: { search: ReturnType<typeof vi.fn>; recentViews: ReturnType<typeof vi.fn> };
  };
}

describe("HeaderSearch", () => {
  beforeEach(async () => {
    localStorage.clear();
    const api = await mockedApi();
    api.articles.search.mockResolvedValue({ hits: [HIT] });
    api.articles.recentViews.mockResolvedValue({ hits: [] });
  });

  const setup = () => render(<MemoryRouter><HeaderSearch /><LocationProbe /></MemoryRouter>);

  it("默认只显示搜索 icon,不显示搜索框", () => {
    setup();
    expect(screen.getByRole("button", { name: "搜索文档" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("搜索文档…")).toBeNull();
  });

  it("点击 icon 弹面板,输入后出结果(防抖+查询词),点结果导航到 /d/:id", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    const input = screen.getByPlaceholderText("搜索文档…");
    fireEvent.change(input, { target: { value: "报销" } });
    const hit = await screen.findByText("报销流程");
    expect((await mockedApi()).articles.search).toHaveBeenCalledWith("报销");
    expect(hit.closest("a")?.getAttribute("href")).toBe("/d/a1");
  });

  it("空态展示搜索历史 + 最近浏览", async () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(["差旅"]));
    (await mockedApi()).articles.recentViews.mockResolvedValue({ hits: [RECENT] });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    expect(await screen.findByText("搜索历史")).toBeTruthy();
    expect(screen.getByText("差旅")).toBeTruthy();
    expect(await screen.findByText("最近浏览")).toBeTruthy();
    expect(screen.getByText("最近文档")).toBeTruthy();
  });

  it("点历史项回填输入并触发搜索", async () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(["报销"]));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    fireEvent.click(await screen.findByText("报销"));
    expect(await screen.findByText("报销流程")).toBeTruthy();
    expect((await mockedApi()).articles.search).toHaveBeenCalledWith("报销");
  });

  it("点结果把当前搜索词写入历史(localStorage)", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    fireEvent.change(screen.getByPlaceholderText("搜索文档…"), { target: { value: "报销" } });
    fireEvent.click(await screen.findByText("报销流程"));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]")).toContain("报销");
    });
  });

  it("回车跳到当前选中(默认第一条)结果", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    const input = screen.getByPlaceholderText("搜索文档…");
    fireEvent.change(input, { target: { value: "报销" } });
    await screen.findByText("报销流程");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/d/a1"));
  });

  it("↓ 选中第二条后回车跳转到它", async () => {
    (await mockedApi()).articles.search.mockResolvedValue({ hits: [HIT, HIT2] });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    const input = screen.getByPlaceholderText("搜索文档…");
    fireEvent.change(input, { target: { value: "报销" } });
    await screen.findByText("报销制度");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/d/a2"));
  });

  it("Esc 关闭面板", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "搜索文档" }));
    expect(screen.getByPlaceholderText("搜索文档…")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("搜索文档…")).toBeNull());
  });
});
