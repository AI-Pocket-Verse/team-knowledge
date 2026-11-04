import { describe, expect, it } from "vitest";
import { L, parseLang } from "./lang.js";
import { outputLanguageInstruction } from "../services/llm/language.js";

describe("lang", () => {
  it("parseLang 只认 zh / en", () => {
    expect(parseLang("en")).toBe("en");
    expect(parseLang(["zh"])).toBe("zh");
    expect(parseLang("fr")).toBeNull();
    expect(parseLang(undefined)).toBeNull();
  });
  it("L 按请求头选文案，没带时用部署语言(默认中文)", () => {
    const req = (h: Record<string, string>) => ({ headers: h }) as never;
    expect(L(req({ "x-lang": "en" }), "目录不存在", "Folder not found")).toBe("Folder not found");
    expect(L(req({}), "目录不存在", "Folder not found")).toBe("目录不存在");
    expect(L("en", "中", "en")).toBe("en");
  });
  it("中文不追加输出语言指令，英文追加", () => {
    expect(outputLanguageInstruction("zh")).toBe("");
    expect(outputLanguageInstruction("en")).toContain("English");
  });
});
