import { describe, expect, it } from "vitest";
import { parseClipboardHtml } from "./parseClipboardHtml";

describe("parseClipboardHtml", () => {
  it("解析出的节点属于惰性文档，不在当前页面的 document 里", () => {
    const body = parseClipboardHtml('<p>hi</p><img src="/uploads/a.png" onerror="window.__hit=true">');
    expect(body.ownerDocument).not.toBe(document);
    expect(body.querySelector("img")?.getAttribute("src")).toBe("/uploads/a.png");
    expect(body.querySelectorAll("p")).toHaveLength(1);
  });

  it("可以像普通容器一样改写后再序列化回 HTML", () => {
    const body = parseClipboardHtml("<pre>a<br>b</pre>");
    const code = document.createElement("code");
    code.textContent = "a\nb";
    const pre = body.querySelector("pre")!;
    pre.textContent = "";
    pre.appendChild(code);
    expect(body.innerHTML).toBe("<pre><code>a\nb</code></pre>");
  });
});
