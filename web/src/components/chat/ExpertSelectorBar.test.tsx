import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ExpertSummary } from "@/lib/api";
import { ExpertSelectorBar } from "./ExpertSelectorBar";
import { setCurrentLang } from "@/i18n/lang";

const EXPERTS: ExpertSummary[] = [
  { roleId: "r1", name: "产品", color: null, instruction: "", avatarUrl: null, webSearch: false, canEdit: true },
  { roleId: "r2", name: "技术", color: null, instruction: "", avatarUrl: null, webSearch: false, canEdit: false },
];

describe("ExpertSelectorBar", () => {
  it("空选:只显示「选择专家」按钮", () => {
    render(<ExpertSelectorBar experts={EXPERTS} value={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /选择专家/ })).toBeTruthy();
    expect(screen.queryByText("技术专家")).toBeNull(); // 下拉未开
  });

  it("点开下拉 → 选技术 → onChange(['r2'])", () => {
    const onChange = vi.fn();
    render(<ExpertSelectorBar experts={EXPERTS} value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专家/ }));
    fireEvent.click(screen.getByText("技术专家"));
    expect(onChange).toHaveBeenCalledWith(["r2"]);
  });

  it("单选:已选产品时点技术 → 替换为 ['r2'](非多选累加)", () => {
    const onChange = vi.fn();
    render(<ExpertSelectorBar experts={EXPERTS} value={["r1"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专家/ }));
    fireEvent.click(screen.getByText("技术专家"));
    expect(onChange).toHaveBeenCalledWith(["r2"]);
  });

  it("点已选项 → 取消(→[])", () => {
    const onChange = vi.fn();
    render(<ExpertSelectorBar experts={EXPERTS} value={["r1"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专家/ }));
    // "产品专家" 同时出现在已选胶囊与面板行;点面板里的那一行(button)取消选择。
    fireEvent.click(screen.getByRole("button", { name: /产品专家/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("已选回填胶囊(名称),尾部 chevron 重开面板;不再有 × 移除按钮", () => {
    render(<ExpertSelectorBar experts={EXPERTS} value={["r1"]} onChange={() => {}} />);
    expect(screen.getByText("产品专家")).toBeTruthy();           // 胶囊回显
    expect(screen.queryByRole("button", { name: /移除/ })).toBeNull(); // 无 × 移除
    fireEvent.click(screen.getByRole("button", { name: /选择专家/ }));  // 尾部 chevron 开面板
    expect(screen.getByPlaceholderText(/搜/)).toBeTruthy();
  });

  it("下拉搜索按名过滤", () => {
    render(<ExpertSelectorBar experts={EXPERTS} value={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专家/ }));
    fireEvent.change(screen.getByPlaceholderText(/搜/), { target: { value: "技术" } });
    expect(screen.getByText("技术专家")).toBeTruthy();
    expect(screen.queryByText("产品专家")).toBeNull();
  });

  it("不再渲染 ⚙ 专家设定入口", () => {
    render(<ExpertSelectorBar experts={EXPERTS} value={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专家/ }));
    expect(screen.queryByRole("button", { name: /设定/ })).toBeNull();
  });
});

describe("ExpertSelectorBar (English)", () => {
  it("renders English labels and the expert suffix", () => {
    setCurrentLang("en");
    try {
      render(<ExpertSelectorBar experts={EXPERTS} value={[]} onChange={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /Choose an expert/ }));
      expect(screen.getByPlaceholderText("Search experts…")).toBeTruthy();
      expect(screen.getByText("技术 expert")).toBeTruthy();
    } finally {
      setCurrentLang("zh");
    }
  });
});
