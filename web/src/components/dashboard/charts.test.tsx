import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AnalyticsComposition, AnalyticsRankings, AnalyticsTrends } from "@team-knowledge/shared";
import { TrendChart } from "./TrendChart";
import { CompositionPies } from "./CompositionPies";
import { RankingsSection } from "./RankingBars";
import { setCurrentLang } from "@/i18n/lang";

const trends: AnalyticsTrends = {
  dayLabels: ["06-05", "06-06", "06-07"],
  docCreate: [1, 2, 3], docEdit: [0, 1, 0], comment: [0, 0, 2], like: [1, 0, 0],
  bookmark: [0, 0, 0], upload: [0, 0, 1], chat: [0, 0, 0], meeting: [0, 0, 0],
  activeUsers: [1, 2, 2],
};
const emptyTrends: AnalyticsTrends = {
  dayLabels: ["06-07"],
  docCreate: [0], docEdit: [0], comment: [0], like: [0],
  bookmark: [0], upload: [0], chat: [0], meeting: [0], activeUsers: [0],
};
const composition: AnalyticsComposition = {
  byRole: [{ roleId: "r1", roleName: "产品", count: 3 }],
  byInteraction: [{ key: "like", count: 2 }, { key: "comment", count: 1 }, { key: "bookmark", count: 0 }],
  byUpload: [{ key: "image", count: 1 }, { key: "document", count: 1 }, { key: "other", count: 0 }],
};
const rankings: AnalyticsRankings = {
  hotDocs: [
    { articleId: "a2", title: "A2", score: 10, viewers: 4, likes: 2, comments: 0, bookmarks: 1 },
    { articleId: "a1", title: "A1", score: 3, viewers: 3, likes: 0, comments: 0, bookmarks: 0 },
  ],
  topContributors: [{ userId: "u1", userName: "User One", ops: 5, contribution: 12.5, breakdown: [{ type: "doc_create", count: 2 }], received: 1 }],
  docsByRole: [{ roleId: "r1", roleName: "产品", count: 3 }],
  skillStatus: [{ status: "fresh", count: 1 }, { status: "failed", count: 1 }],
};

describe("TrendChart", () => {
  it("renders title + series chips when there is data", () => {
    render(<TrendChart trends={trends} />);
    expect(screen.getByText("内容与互动趋势")).toBeInTheDocument();
    expect(screen.getByText("新增文档")).toBeInTheDocument();
    expect(screen.getByText("活跃用户")).toBeInTheDocument();
    expect(screen.queryByText("暂无数据")).not.toBeInTheDocument();
  });

  it("shows empty state when all series are zero", () => {
    render(<TrendChart trends={emptyTrends} />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("toggles a series chip via aria-pressed", () => {
    render(<TrendChart trends={trends} />);
    const chip = screen.getByRole("button", { name: /新增文档/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });
});

describe("CompositionPies", () => {
  it("renders pie titles + slice labels(去状态后无「文档状态占比」)", () => {
    render(<CompositionPies composition={composition} />);
    expect(screen.getByText("各角色文档占比")).toBeInTheDocument();
    expect(screen.getByText("互动类型占比")).toBeInTheDocument();
    expect(screen.getByText("上传类型占比")).toBeInTheDocument();
    expect(screen.queryByText("文档状态占比")).not.toBeInTheDocument();
    expect(screen.getByText("图片")).toBeInTheDocument();
  });
});

describe("RankingsSection", () => {
  it("renders the four ranking lists with items", () => {
    render(<RankingsSection rankings={rankings} />);
    expect(screen.getByText("热门文档")).toBeInTheDocument();
    expect(screen.getByText("活跃贡献者")).toBeInTheDocument();
    expect(screen.getByText("各角色文档数")).toBeInTheDocument();
    expect(screen.getByText("角色 Skill 状态")).toBeInTheDocument();
    expect(screen.getByText("A2")).toBeInTheDocument();
    expect(screen.getByText("最新")).toBeInTheDocument(); // skill status label
  });

  it("invokes drill-down callbacks on click", () => {
    const onDoc = vi.fn();
    render(<RankingsSection rankings={rankings} onDoc={onDoc} />);
    fireEvent.click(screen.getByText("A2"));
    expect(onDoc).toHaveBeenCalledWith("a2");
  });

  it("renders an empty state for an empty ranking", () => {
    render(<RankingsSection rankings={{ hotDocs: [], topContributors: [], docsByRole: [], skillStatus: [] }} />);
    expect(screen.getAllByText("暂无数据")).toHaveLength(4);
  });
});

describe("dashboard in English", () => {
  it("renders English labels and restores zh", () => {
    setCurrentLang("en");
    try {
      render(<><TrendChart trends={trends} /><CompositionPies composition={composition} /><RankingsSection rankings={rankings} /></>);
      expect(screen.getByText("Content & engagement trends")).toBeInTheDocument();
      expect(screen.getAllByText("Docs by role")).toHaveLength(2);
      expect(screen.getByText("Top docs")).toBeInTheDocument();
      expect(screen.getByText("Images")).toBeInTheDocument();
      expect(screen.queryByText("内容与互动趋势")).not.toBeInTheDocument();
    } finally {
      setCurrentLang("zh");
    }
  });
});
