import { describe, it, expect } from "vitest";
import { parseMarkers, parseUsedMarker, hasExpertMarker, parseImageMarker } from "./markers.js";

describe("experts/parseImageMarker", () => {
  it("[[IMAGE: ...]] → 提取提示词 + 剥除标记", () => {
    const r = parseImageMarker("[[IMAGE: a cute orange cat sitting on a desk, watercolor]]");
    expect(r.prompt).toBe("a cute orange cat sitting on a desk, watercolor");
    expect(r.clean).toBe("");
  });
  it("全角冒号也行;无标记 → prompt=null", () => {
    expect(parseImageMarker("[[IMAGE:画一只猫]]").prompt).toBe("画一只猫");
    expect(parseImageMarker("这是普通回答,没有标记。").prompt).toBeNull();
  });
});

describe("experts/hasExpertMarker", () => {
  it("[[EXPERT]] 存在 → true(门控判专用)", () => {
    expect(hasExpertMarker("[[EXPERT]]")).toBe(true);
    expect(hasExpertMarker("一些前言\n[[EXPERT]]")).toBe(true);
    expect(hasExpertMarker("[[ EXPERT ]]")).toBe(true); // 容空格
  });
  it("通用答复(无标记) → false", () => {
    expect(hasExpertMarker("你想查哪个城市的天气?")).toBe(false);
    expect(hasExpertMarker("见参考 [[1]] 和 [[2]]。")).toBe(false); // 普通 [[ 不误判
  });
});

describe("experts/parseUsedMarker", () => {
  it("[[USED: #1 #3]] → 编号数组 + 剥除标记", () => {
    const r = parseUsedMarker("答复正文。\n[[USED: #1 #3]]");
    expect(r.usedNs).toEqual([1, 3]);
    expect(r.clean).toBe("答复正文。");
  });
  it("[[USED: none]] → 空数组(没用到任何参考资料)", () => {
    const r = parseUsedMarker("我是通用助手。\n[[USED: none]]");
    expect(r.usedNs).toEqual([]);
    expect(r.clean).toBe("我是通用助手。");
  });
  it("无标记 → usedNs=null(调用方回退原口径)", () => {
    const r = parseUsedMarker("普通答复,没有标记。");
    expect(r.usedNs).toBeNull();
    expect(r.clean).toBe("普通答复,没有标记。");
  });
  it("全角冒号 / 「无」/ 裸数字都能解析", () => {
    expect(parseUsedMarker("x\n[[USED:无]]").usedNs).toEqual([]);
    expect(parseUsedMarker("x\n[[USED: 2 4]]").usedNs).toEqual([2, 4]);
  });
});

describe("experts/markers", () => {
  it("解析 CONSULT,剥掉标记行", () => {
    const r = parseMarkers("我先看下。\n[[CONSULT: 技术 | 这个改动影响架构吗?]]\n初步结论是可行。");
    expect(r.consult).toEqual({ target: "技术", question: "这个改动影响架构吗?" });
    expect(r.escalate).toBeNull();
    expect(r.clean).toBe("我先看下。\n\n初步结论是可行。");
  });

  it("解析 ESCALATE(含候选,中英标点都行)", () => {
    const r = parseMarkers("拿不准。[[ESCALATE:续期时长定不了 | 选 7 天还是 30 天? | 7 天;30 天]]");
    expect(r.escalate).toEqual({ background: "续期时长定不了", question: "选 7 天还是 30 天?", options: ["7 天", "30 天"] });
    expect(r.clean).toBe("拿不准。");
  });

  it("模型违规输出两个同类标记 → 只执行第一个,但两个都从 clean 剥除(无残留泄漏)", () => {
    const r = parseMarkers("答复。[[CONSULT: 技术 | 问题一]] 中段。[[CONSULT: 设计 | 问题二]] 结尾。");
    expect(r.consult).toEqual({ target: "技术", question: "问题一" }); // 只执行第一个
    expect(r.clean).not.toContain("CONSULT");                          // 第二个也被剥掉
    expect(r.clean).not.toContain("[[");
  });

  it("无标记 → 原样,consult/escalate 为 null", () => {
    const r = parseMarkers("这是普通回答。");
    expect(r).toEqual({ clean: "这是普通回答。", consult: null, escalate: null });
  });
});
