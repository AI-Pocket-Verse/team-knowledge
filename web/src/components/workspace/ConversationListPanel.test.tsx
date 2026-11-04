import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ConversationListItem } from "@/lib/api";
import { ConversationListPanel } from "./ConversationListPanel";

const items: ConversationListItem[] = [
  { id: "f", title: null, isFeishu: true, pinned: false, lastMessageAt: null, createdAt: "x" },
  { id: "c1", title: "需求拆解", isFeishu: false, pinned: false, lastMessageAt: null, createdAt: "x" },
];

const noop = () => {};
const base = { onNew: noop, onPick: noop, onRename: noop, onPin: noop, onDelete: noop };

describe("ConversationListPanel", () => {
  it("渲染「新对话」+ 列表;飞书项有标记;无标题回退占位", () => {
    render(
      <MemoryRouter>
        <ConversationListPanel items={items} activeId="c1" {...base} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /新对话/ })).toBeTruthy();
    expect(screen.getByText("需求拆解")).toBeTruthy();
    expect(screen.getByText("飞书")).toBeTruthy();           // 飞书标记(简洁标签)
    expect(screen.getByText("飞书对话")).toBeTruthy();       // 无标题飞书项回退占位
  });

  it("点列表项 → onPick(id)", () => {
    const onPick = vi.fn();
    render(
      <MemoryRouter>
        <ConversationListPanel items={items} activeId={null} {...base} onPick={onPick} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("需求拆解"));
    expect(onPick).toHaveBeenCalledWith("c1");
  });

  it("点「新对话」→ onNew", () => {
    const onNew = vi.fn();
    render(
      <MemoryRouter>
        <ConversationListPanel items={items} activeId={null} {...base} onNew={onNew} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /新对话/ }));
    expect(onNew).toHaveBeenCalled();
  });

  it("点 ⋯ → 菜单含 重命名/置顶/删除;点置顶 → onPin(id, true)", () => {
    const onPin = vi.fn();
    render(
      <MemoryRouter>
        <ConversationListPanel items={items} activeId={null} {...base} onPin={onPin} />
      </MemoryRouter>,
    );
    // 仅非飞书项有 ⋯ 按钮(飞书项是常驻入口、无菜单)。
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByText("重命名")).toBeTruthy();
    expect(screen.getByText("置顶")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
    fireEvent.click(screen.getByText("置顶"));
    expect(onPin).toHaveBeenCalledWith("c1", true);
  });

  it("右键列表项 → 唤起同一菜单(重命名/置顶/删除)", () => {
    const onDelete = vi.fn();
    render(
      <MemoryRouter>
        <ConversationListPanel items={items} activeId={null} {...base} onDelete={onDelete} />
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByText("需求拆解"));
    expect(screen.getByText("重命名")).toBeTruthy();
    expect(screen.getByText("置顶")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("右键飞书项 → 不弹菜单(飞书会话无操作菜单)", () => {
    render(
      <MemoryRouter>
        <ConversationListPanel items={items} activeId={null} {...base} />
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByText("飞书对话"));
    expect(screen.queryByText("重命名")).toBeNull();
  });

  it("已置顶项:显示「取消置顶」,点击 → onPin(id, false)", () => {
    const onPin = vi.fn();
    const pinned: ConversationListItem[] = [
      { id: "c1", title: "需求拆解", isFeishu: false, pinned: true, lastMessageAt: null, createdAt: "x" },
    ];
    render(
      <MemoryRouter>
        <ConversationListPanel items={pinned} activeId={null} {...base} onPin={onPin} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByText("取消置顶"));
    expect(onPin).toHaveBeenCalledWith("c1", false);
  });
});
