import { describe, it, expect } from "vitest";
import { parseFeishuUrl } from "./feishuUrl.js";

describe("parseFeishuUrl", () => {
  it("parses a docx link (strips query)", () => {
    expect(parseFeishuUrl("https://x.feishu.cn/docx/DocAbc123?from=share")).toEqual({
      kind: "docx",
      token: "DocAbc123",
    });
  });

  it("parses a wiki link", () => {
    expect(parseFeishuUrl("https://x.feishu.cn/wiki/WikXyz789")).toEqual({
      kind: "wiki",
      token: "WikXyz789",
    });
  });

  it("accepts feishu.cn and larksuite.com hosts", () => {
    expect(parseFeishuUrl("https://abc.larksuite.com/docx/D1")?.kind).toBe("docx");
  });

  it("trims surrounding whitespace", () => {
    expect(parseFeishuUrl("  https://x.feishu.cn/docx/D2  ")).toEqual({ kind: "docx", token: "D2" });
  });

  it("returns null for unsupported paths / hosts / garbage", () => {
    expect(parseFeishuUrl("https://x.feishu.cn/sheets/Sh1")).toBeNull();
    expect(parseFeishuUrl("https://x.feishu.cn/docs/Old1")).toBeNull();
    expect(parseFeishuUrl("https://evil.com/docx/D1")).toBeNull();
    expect(parseFeishuUrl("https://x.feishu.cn/docx/")).toBeNull();
    expect(parseFeishuUrl("not a url")).toBeNull();
  });
});
