import { describe, it, expect, beforeEach } from "vitest";
import {
  readSearchHistory,
  addSearchHistory,
  removeSearchHistory,
  clearSearchHistory,
} from "./searchHistory";

describe("searchHistory", () => {
  beforeEach(() => localStorage.clear());

  it("空时返回空数组", () => {
    expect(readSearchHistory()).toEqual([]);
  });

  it("add 置顶 + 去重(同词移到最前,不重复)", () => {
    addSearchHistory("报销");
    addSearchHistory("请假");
    expect(addSearchHistory("报销")).toEqual(["报销", "请假"]);
  });

  it("空白词不记录", () => {
    addSearchHistory("报销");
    expect(addSearchHistory("   ")).toEqual(["报销"]);
  });

  it("上限 8 条,超出丢弃最旧", () => {
    for (let i = 0; i < 10; i++) addSearchHistory(`q${i}`);
    const list = readSearchHistory();
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("q9");
    expect(list).not.toContain("q0");
  });

  it("remove 删除指定条", () => {
    addSearchHistory("a");
    addSearchHistory("b");
    expect(removeSearchHistory("a")).toEqual(["b"]);
  });

  it("clear 清空", () => {
    addSearchHistory("a");
    expect(clearSearchHistory()).toEqual([]);
    expect(readSearchHistory()).toEqual([]);
  });

  it("坏数据(非数组 / 含非字符串)静默降级", () => {
    localStorage.setItem("assistant.searchHistory", "not json");
    expect(readSearchHistory()).toEqual([]);
    localStorage.setItem("assistant.searchHistory", JSON.stringify(["ok", 42, "", "good"]));
    expect(readSearchHistory()).toEqual(["ok", "good"]);
  });
});
