import { describe, it, expect } from "vitest";
import { looksLikeLikeCandidate, parseScore, parseEmoji } from "./like.js";

describe("group-qa like · 预筛 looksLikeLikeCandidate", () => {
  it("有实质内容的分享/解答 → 通过", () => {
    expect(looksLikeLikeCandidate("这个问题的根因是连接池没释放,改成 try-with-resources 就好了")).toBe(true);
    expect(looksLikeLikeCandidate("部署踩坑:turbo build 不加 --force 会回放旧 dist,记得加")).toBe(true);
  });

  it("太短 / 纯寒暄附和 / 情绪 → 拒绝", () => {
    expect(looksLikeLikeCandidate("收到")).toBe(false);
    expect(looksLikeLikeCandidate("好的好的")).toBe(false);
    expect(looksLikeLikeCandidate("谢谢啦")).toBe(false);
    expect(looksLikeLikeCandidate("哈哈哈哈哈")).toBe(false);
    expect(looksLikeLikeCandidate("666666")).toBe(false);
    expect(looksLikeLikeCandidate("赞")).toBe(false);
  });

  it("去掉链接/@/表情后实质文本不足 → 拒绝", () => {
    expect(looksLikeLikeCandidate("https://example.com/a/very/long/link/here/xyz")).toBe(false);
    expect(looksLikeLikeCandidate("@张三 @李四 👍👍👍👍👍👍")).toBe(false);
  });

  it("斜杠命令 → 拒绝", () => {
    expect(looksLikeLikeCandidate("/help 这是一个很长的命令行内容占位")).toBe(false);
  });
});

describe("group-qa like · parseScore", () => {
  it("抠出 0-10 的整数并夹紧", () => {
    expect(parseScore("8")).toBe(8);
    expect(parseScore("分数:9")).toBe(9);
    expect(parseScore("0")).toBe(0);
    expect(parseScore("12")).toBe(10); // 上界夹紧
    expect(parseScore("-3")).toBe(0);  // 下界夹紧
  });

  it("smart 格式:优先取 | 之前的分数(表情名里的字符不干扰)", () => {
    expect(parseScore("9|APPLAUSE")).toBe(9);
    expect(parseScore("8 | DONE")).toBe(8);
    expect(parseScore("10|HEART")).toBe(10);
  });

  it("抠不到数字 → null", () => {
    expect(parseScore("无法判断")).toBeNull();
    expect(parseScore("")).toBeNull();
  });
});

describe("group-qa like · parseEmoji(smart 模式)", () => {
  it("抠出白名单内的表情", () => {
    expect(parseEmoji("8|DONE")).toBe("DONE");
    expect(parseEmoji("9 | HEART")).toBe("HEART");
    expect(parseEmoji("thumbsup")).toBe("THUMBSUP"); // 大小写不敏感
  });
  it("白名单外 / 无表情 → null(调用方回退兜底)", () => {
    expect(parseEmoji("8|PARTY")).toBeNull();
    expect(parseEmoji("8")).toBeNull();
  });

  it("词边界匹配:普通英文词里的子串不误命中(OK ⊂ LOOKS/BOOK)", () => {
    // 「LOOKS good」含子串 OK,但不是独立的 OK 表情 → 应识别为 DONE,而非误判 OK。
    expect(parseEmoji("8|DONE, this looks good")).toBe("DONE");
    expect(parseEmoji("9 the book is great")).toBeNull(); // BOOK 含 OK,但无独立表情
    expect(parseEmoji("8 | OK")).toBe("OK");              // 独立的 OK 仍能命中
  });
});
