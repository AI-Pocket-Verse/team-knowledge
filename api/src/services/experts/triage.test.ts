import { describe, it, expect } from "vitest";
import { triage, type TriageRole } from "./triage.js";

const ROLES: TriageRole[] = [
  { roleId: "r-prod", name: "产品", instruction: "" },
  { roleId: "r-tech", name: "技术", instruction: "" },
];

describe("experts/triage", () => {
  it("显式 targetRoleIds 优先,过滤到清单内、去重、限 3 个", async () => {
    expect(await triage("q", ROLES, { targetRoleIds: ["r-tech", "r-tech", "r-nope"] })).toEqual(["r-tech"]);
  });

  it("LLM 选出清单内角色;非法 id 被过滤", async () => {
    const out = await triage("登录改造可行性", ROLES, {
      runLlm: async () => '{"roleIds":["r-prod","r-tech","r-ghost"]}',
    });
    expect(out).toEqual(["r-prod", "r-tech"]);
  });

  it("LLM 用角色【名称】作答 → 归一回 roleId(更稳,避免抄错 cuid)", async () => {
    const out = await triage("登录改造", ROLES, {
      runLlm: async () => '{"roleIds":["产品","技术","不存在的角色"]}',
    });
    expect(out).toEqual(["r-prod", "r-tech"]);
  });

  it("子串歧义(多角色都命中)→ 跳过该条,不 first-match-wins 误路由", async () => {
    const roles: TriageRole[] = [
      { roleId: "r-dev", name: "技术开发", instruction: "" },
      { roleId: "r-sup", name: "技术支持", instruction: "" },
    ];
    // "技术" 同时是「技术开发」「技术支持」的子串 → 歧义 → 跳过(返回空)。
    expect(await triage("q", roles, { runLlm: async () => '{"roleIds":["技术"]}' })).toEqual([]);
    // 唯一精确名仍正常解析。
    expect(await triage("q", roles, { runLlm: async () => '{"roleIds":["技术支持"]}' })).toEqual(["r-sup"]);
  });

  it("LLM 返回乱码 / 空 → [](总台自答);无 runLlm 且无显式 → []", async () => {
    expect(await triage("q", ROLES, { runLlm: async () => "我觉得找产品吧" })).toEqual([]);
    expect(await triage("q", ROLES, { runLlm: async () => null })).toEqual([]);
    expect(await triage("q", ROLES, {})).toEqual([]);
  });

  it("空角色清单 → []", async () => {
    expect(await triage("q", [], { targetRoleIds: ["r-prod"] })).toEqual([]);
  });
});
