import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// UPLOAD_PREFIX 在模块加载时从 import.meta.env.BASE_URL 取值,所以每个
// 用例先 stubEnv 再动态 import 一份新模块。
async function loadApi(base: string) {
  vi.stubEnv("BASE_URL", base);
  vi.resetModules();
  return await import("./api");
}

describe("uploads 地址 显示形态 ↔ 存储形态", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("uploadSrc:/uploads/* 补 BASE_URL 前缀,其它地址原样", async () => {
    const { uploadSrc } = await loadApi("/kb/");
    expect(uploadSrc("/uploads/a.png")).toBe("/kb/uploads/a.png");
    expect(uploadSrc("https://x.y/z.png")).toBe("https://x.y/z.png");
    expect(uploadSrc("/kb/uploads/a.png")).toBe("/kb/uploads/a.png");
  });

  it("uploadsToDisplay/uploadsToStorage:markdown 链接与内联 HTML src 双向往返", async () => {
    const { uploadsToDisplay, uploadsToStorage } = await loadApi("/kb/");
    const stored = [
      "![图](/uploads/a.png) 文字 [📎 附件 (1 KB)](/uploads/b.pdf)",
      '<img src="/uploads/c.png" alt="x">',
      "外链不动:![w](https://w.x/y.png) (/uploads-not-a-dir/z)",
    ].join("\n");
    const display = uploadsToDisplay(stored);
    expect(display).toContain("](/kb/uploads/a.png)");
    expect(display).toContain("](/kb/uploads/b.pdf)");
    expect(display).toContain('src="/kb/uploads/c.png"');
    expect(display).toContain("https://w.x/y.png");
    // (/uploads-not-a-dir/ 不带尾斜杠的相似前缀不受影响
    expect(display).toContain("(/uploads-not-a-dir/z)");
    // 往返无损:序列化回存储与原文一致
    expect(uploadsToStorage(display)).toBe(stored);
    // 已是存储形态的文本再剥一次是幂等的
    expect(uploadsToStorage(stored)).toBe(stored);
  });

  it("BASE_URL='/'(无前缀)时两个变换都是恒等", async () => {
    const { uploadsToDisplay, uploadsToStorage, uploadSrc } = await loadApi("/");
    const md = "![图](/uploads/a.png)";
    expect(uploadsToDisplay(md)).toBe(md);
    expect(uploadsToStorage(md)).toBe(md);
    expect(uploadSrc("/uploads/a.png")).toBe("/uploads/a.png");
  });
});
