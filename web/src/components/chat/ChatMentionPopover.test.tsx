import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatMentionPopover } from "./ChatMentionPopover";

vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      listRoles: vi.fn().mockResolvedValue({ roles: [{ id: "r1", name: "产品" }, { id: "r2", name: "设计" }] }),
      tree: vi.fn().mockResolvedValue({ folders: [] }),
    },
    roleSkill: {
      summary: vi.fn().mockResolvedValue({
        skills: [
          { roleId: "r1", roleName: "产品", status: "fresh", usable: true },
          { roleId: "r2", roleName: "设计", status: "empty", usable: false },
        ],
      }),
    },
    feed: vi.fn().mockResolvedValue({ articles: [] }),
    articles: { search: vi.fn().mockResolvedValue({ hits: [] }) },
  },
}));

const anchor = { left: 100, caretTop: 300, caretBottom: 320 };

// jsdom 未实现 scrollIntoView;弹窗会把选中行滚动到可视区,stub 掉避免抛错。
Element.prototype.scrollIntoView = vi.fn();

describe("ChatMentionPopover Skills tab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("greys out + disables a role with no generated skill, and only selects usable ones", async () => {
    const onSelect = vi.fn();
    render(<ChatMentionPopover query="" anchor={anchor} onSelect={onSelect} onClose={vi.fn()} />);

    // Switch to the Skills tab.
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Skills/ }));

    // Both roles list once the skill summary loads.
    const usable = (await screen.findByText("产品")).closest('[role="option"]')!;
    const disabled = screen.getByText("设计").closest('[role="option"]')!;

    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(usable).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByText("未生成,无法选择")).toBeInTheDocument();

    // Clicking the disabled (un-generated) skill does nothing.
    fireEvent.mouseDown(disabled);
    expect(onSelect).not.toHaveBeenCalled();

    // Clicking the usable skill emits a skill mention.
    fireEvent.mouseDown(usable);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: "skill", id: "r1", label: "产品" }));
  });

  it("内置搜索框按名过滤当前 tab(Skills)", async () => {
    render(<ChatMentionPopover query="" anchor={anchor} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Skills/ }));
    await screen.findByText("产品"); // 两个 skill 都在
    expect(screen.getByText("设计")).toBeInTheDocument();
    // 在内置搜索框输入「设计」→ 只剩设计
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: "设计" } });
    expect(screen.queryByText("产品")).not.toBeInTheDocument();
    expect(screen.getByText("设计")).toBeInTheDocument();
  });
});
