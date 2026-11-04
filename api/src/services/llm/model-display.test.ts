import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import {
  composeDisplay, getModelDisplayConfig, setModelDisplayConfig,
  resolveModelDisplay, getGroupCardModel,
} from "./model-display.js";

describe("model-display · composeDisplay(纯函数)", () => {
  it("三段拼接(空段跳过)", () => {
    expect(composeDisplay({ model: "Codex", version: "5.6-sol", level: "high" }, "codex")).toBe("Codex 5.6-sol high");
    expect(composeDisplay({ model: "Claude", version: "", level: "high" }, "claude")).toBe("Claude high");
  });
  it("三段全空 → 回退 provider 标签", () => {
    expect(composeDisplay({ model: "", version: "", level: "" }, "claude")).toBe("Claude Code");
    expect(composeDisplay({ model: " ", version: "", level: "" }, "codex")).toBe("Codex");
  });
});

describe("model-display · 配置读写(DB)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("默认:两组空 + 群卡片默认不显示", async () => {
    const c = await getModelDisplayConfig();
    expect(c).toEqual({
      claude: { model: "", version: "", level: "" },
      codex: { model: "", version: "", level: "" },
      showInGroupCard: false,
    });
  });

  it("部分更新 + 裁剪 + 回读一致", async () => {
    const next = await setModelDisplayConfig({ codex: { model: "Codex", version: "5.6-sol", level: "high" }, showInGroupCard: true }, "admin");
    expect(next.codex).toEqual({ model: "Codex", version: "5.6-sol", level: "high" });
    expect(next.claude).toEqual({ model: "", version: "", level: "" }); // 未传保持空
    expect(next.showInGroupCard).toBe(true);
    expect(await getModelDisplayConfig()).toEqual(next);
  });

  it("resolveModelDisplay:手填为准;非 claude/codex 原样返回", async () => {
    await setModelDisplayConfig({ codex: { model: "Codex", version: "5.6-sol", level: "high" } }, "admin");
    expect(await resolveModelDisplay("codex")).toBe("Codex 5.6-sol high");
    expect(await resolveModelDisplay("claude")).toBe("Claude Code"); // 未填 → 标签
    expect(await resolveModelDisplay("some-other")).toBe("some-other");
  });

  it("getGroupCardModel:开关关→undefined;开→当前 provider 的 curated", async () => {
    // 默认 provider = claude,先给 claude 填上
    await setModelDisplayConfig({ claude: { model: "Claude", version: "4.8", level: "high" } }, "admin");
    expect(await getGroupCardModel()).toBeUndefined(); // 默认开关关
    await setModelDisplayConfig({ showInGroupCard: true }, "admin");
    expect(await getGroupCardModel()).toBe("Claude 4.8 high");
  });
});
