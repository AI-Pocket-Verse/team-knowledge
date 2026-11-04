import { describe, expect, it } from "vitest";
import { buildStandaloneReportHtml } from "./weeklyReportHtml";

describe("buildStandaloneReportHtml", () => {
  it("标题里的 HTML 被转义,不会在 document.write 时变成标签", () => {
    const html = buildStandaloneReportHtml(`知识库周报 </title><img src=x onerror="alert(1)">&`, "<div id=wr-root>ok</div>");
    expect(html).toContain("<title>知识库周报 &lt;/title&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;</title>");
    expect(html).not.toContain("<img");
    expect(html).toContain("<body><div id=wr-root>ok</div></body>");
  });
});
