import { describe, it, expect } from "vitest";
import { docDeepLink, buildNotificationCard, applinkWrap } from "./card.js";

describe("docDeepLink", () => {
  it("builds an absolute doc link, with optional comment anchor", () => {
    expect(docDeepLink("a1")).toMatch(/\/d\/a1$/);
    expect(docDeepLink("a1", "c2")).toMatch(/\/d\/a1#comment-c2$/);
  });
});

describe("applinkWrap", () => {
  it("returns the plain url when applink is off", () => {
    expect(applinkWrap("https://x/d/a1", false)).toBe("https://x/d/a1");
  });
  it("wraps in a Feishu applink when on", () => {
    const w = applinkWrap("https://x/d/a1#comment-c2", true);
    expect(w).toContain("applink.feishu.cn/client/web_url/open?url=");
    expect(w).toContain(encodeURIComponent("https://x/d/a1#comment-c2"));
  });
});

describe("buildNotificationCard", () => {
  it("carries article title + 查看文档 button to the deep link (with comment anchor)", () => {
    const card = buildNotificationCard({
      type: "article_comment", actorName: "张三", articleTitle: "PRD",
      articleId: "a1", commentId: "c2", excerpt: "看看这里",
    });
    const json = JSON.stringify(card);
    expect(json).toContain("张三");
    expect(json).toContain("PRD");
    expect(json).toContain("查看文档");
    expect(json).toContain("/d/a1#comment-c2");
    expect(json).toContain("看看这里");
  });

  it("omits the excerpt block when none is given", () => {
    const card = buildNotificationCard({
      type: "article_like", actorName: "李四", articleTitle: "Doc", articleId: "a9",
    });
    const json = JSON.stringify(card);
    expect(json).toContain("李四");
    expect(json).toContain("/d/a9");
  });

  it("article_review_issue:标题为『文档待优化』,正文含文档名与摘要,带查看按钮", () => {
    const card = buildNotificationCard({
      type: "article_review_issue",
      actorName: "AI 体检",
      articleTitle: "请假流程",
      articleId: "art1",
      excerpt: "3 处问题:逻辑矛盾、信息缺失/过时",
    }) as { header: { title: { content: string } }; elements: unknown[] };
    expect(card.header.title.content).toBe("文档待优化");
    const json = JSON.stringify(card.elements);
    expect(json).toContain("请假流程");
    expect(json).toContain("3 处问题");
    expect(json).toContain("查看文档");
  });

  it("文档标题里的半角方括号被转成全角,不会拼出可点击链接", () => {
    const card = buildNotificationCard({
      type: "article_like", actorName: "张三", articleTitle: "[紧急](https://evil.example/x)",
      articleId: "a1",
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain("[紧急]");
    expect(json).toContain("［紧急］");
  });
});
